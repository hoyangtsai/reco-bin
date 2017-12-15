const path = require('path');
const assert = require('assert');
const fs = require('fs');
const urllib = require('urllib');
const debug = require('debug')('reco-bin');
const cp = require('child_process');
const is = require('is-type-of');
const unparse = require('dargs');
const homedir = require('node-homedir');
const util = require('util');
const webpackMerge = require('webpack-merge');
const spawn = require('cross-spawn');

// only hook once and only when ever start any child.
const childs = new Set();
let hadHook = false;
function gracefull(proc) {
  // save child ref
  childs.add(proc);

  // only hook once
  /* istanbul ignore else */
  if (!hadHook) {
    hadHook = true;
    let signal;
    ['SIGINT', 'SIGQUIT', 'SIGTERM'].forEach((event) => {
      process.once(event, () => {
        signal = event;
        process.exit(0);
      });
    });

    process.once('exit', () => {
      // had test at my-helper.test.js, but coffee can't collect coverage info.
      for (const child of childs) {
        debug('kill child %s with %s', child.pid, signal);
        child.kill(signal);
      }
    });
  }
}

/**
 * fork child process, wrap with promise and gracefull exit
 * @method helper#forkNode
 * @param {String} modulePath - bin path
 * @param {Array} [args] - arguments
 * @param {Object} [options] - options
 * @return {Promise} err or undefined
 * @see https://nodejs.org/api/child_process.html#child_process_child_process_fork_modulepath_args_options
 */
exports.forkNode = (modulePath, args = [], options = {}) => {
  options.stdio = options.stdio || 'inherit';
  debug('Run fork `%s %s %s`', process.execPath, modulePath, args.join(' '));
  const proc = cp.fork(modulePath, args, options);
  gracefull(proc);

  return new Promise((resolve, reject) => {
    proc.once('exit', (code) => {
      childs.delete(proc);
      if (code !== 0) {
        const err = new Error(`${modulePath} ${args} exit with code ${code}`);
        err.code = code;
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

/**
 * spawn a new process, wrap with promise and gracefull exit
 * @method helper#forkNode
 * @param {String} cmd - command
 * @param {Array} [args] - arguments
 * @param {Object} [options] - options
 * @return {Promise} err or undefined
 * @see https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options
 */
exports.spawn = (cmd, args = [], options = {}) => {
  options.stdio = options.stdio || 'inherit';
  debug('Run spawn `%s %s`', cmd, args.join(' '));

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, options);
    gracefull(proc);
    proc.once('error', (err) => {
      /* istanbul ignore next */
      reject(err);
    });
    proc.once('exit', (code) => {
      childs.delete(proc);

      if (code !== 0) {
        return reject(new Error(`spawn ${cmd} ${args.join(' ')} fail, exit code: ${code}`));
      }
      return resolve();
    });
  });
};

/**
 * exec npm install
 * @method helper#npmInstall
 * @param {String} npmCli - npm cli, such as `npm` / `cnpm` / `npminstall`
 * @param {String} name - node module name
 * @param {String} cwd - target directory
 * @return {Promise} err or undefined
 */
exports.npmInstall = (npmCli, name, cwd) => {
  const options = {
    stdio: 'inherit',
    env: process.env,
    cwd,
  };

  const args = ['i', name];
  console.log('[reco] `%s %s` to %s ...', npmCli, args.join(' '), options.cwd);

  return exports.spawn(npmCli, args, options);
};

/**
 * call fn
 * @method helper#callFn
 * @param {Function} fn - support gernerator / async / normal function return promise
 * @param {Array} [args] - fn args
 * @param {Object} [thisArg] - this
 * @return {Object} result
 */
exports.callFn = function* (fn, args = [], thisArg) {
  if (!is.function(fn)) return null;
  if (is.generatorFunction(fn)) {
    return yield fn.apply(thisArg, args);
  }
  const r = fn.apply(thisArg, args);
  if (is.promise(r)) {
    return yield r;
  }
  return r;
};

/**
 * unparse argv and change it to array style
 * @method helper#unparseArgv
 * @param {Object} argv - yargs style
 * @param {Object} [options] - options, see more at https://github.com/sindresorhus/dargs
 * @param {Array} [options.includes] - keys or regex of keys to include
 * @param {Array} [options.excludes] - keys or regex of keys to exclude
 * @return {Array} [ '--debug=7000', '--debug-brk' ]
 */
exports.unparseArgv = (argv, options = {}) =>
  // revert argv object to array
  // yargs will paser `debug-brk` to `debug-brk` and `debugBrk`, so we need to filter
   [...new Set(unparse(argv, options))];

/**
 * extract execArgv from argv
 * @method helper#extractExecArgv
 * @param {Object} argv - yargs style
 * @return {Object} { debugPort, debugOptions: {}, execArgvObj: {} }
 */
exports.extractExecArgv = (argv) => {
  const debugOptions = {};
  const execArgvObj = {};
  let debugPort;

  for (const key of Object.keys(argv)) {
    const value = argv[key];
    // skip undefined set uppon (camel etc.)
    if (value === undefined) continue;
    // debug / debug-brk / debug-port / inspect / inspect-brk / inspect-port
    if (['debug', 'debug-brk', 'debug-port', 'inspect', 'inspect-brk', 'inspect-port'].includes(key)) {
      if (typeof value === 'number') debugPort = value;
      debugOptions[key] = argv[key];
      execArgvObj[key] = argv[key];
    } else if (match(key, ['es_staging', 'expose_debug_as', /^harmony.*/])) {
      execArgvObj[key] = argv[key];
    }
  }
  return { debugPort, debugOptions, execArgvObj };
};

/**
 * get registryUrl by short name
 * @param {String} key - short name, support `china / npm / npmrc`, default to read from .npmrc
 * @return {String} registryUrl
 */
exports.getRegistryByType = (key) => {
  switch (key) {
    case 'tnpm':
      return 'http://r.tnpm.oa.com';
    case 'china':
      return 'https://registry.npm.taobao.org';
    case 'npm':
      return 'https://registry.npmjs.org';
    default:
      {
        if (/^https?:/.test(key)) {
          return key.replace(/\/$/, '');
        }
        // support .npmrc
        const home = homedir();
        let url = process.env.npm_registry || process.env.npm_config_registry || 'https://registry.cnpmjs.org';
        if (fs.existsSync(path.join(home, '.cnpmrc')) || fs.existsSync(path.join(home, '.tnpmrc'))) {
          url = 'https://r.tnpm.oa.com';
        }
        url = url.replace(/\/$/, '');
        return url;
      }
  }
};

/**
* Get package info from registry
*
* @param {String} registryUrl - registry url
* @param {String} pkgName - package name
* @param {Boolean} withFallback  - when http request fail, whethe to request local
* @param {Function} log - log function, default is console.log
*/
exports.getPackageInfo = function* (registryUrl, pkgName, withFallback, log = console.log) {
  log(`fetching npm info of ${pkgName}`);
  try {
    const result = yield urllib.request(`${registryUrl}/${pkgName}/latest`, {
      dataType: 'json',
      followRedirect: true,
    });
    assert(result.status === 200, `npm info ${pkgName} failed, got error: ${result.status}, ${result.data.reason}`);
    return result.data;
  } catch (err) {
    if (withFallback) {
      log(`use fallbck for package ${pkgName}`);
      return require(`${pkgName}/package.json`); // eslint-disable-line import/no-dynamic-require,global-require
    }
    throw err;
  }
};

exports.getToolkitDir = (toolkit, recoDir) => {
  if (!toolkit) {
    throw new Error('Argument toolkit is required!');
  }
  const isPkg = toolkit.startsWith('@tencent');
  return isPkg ? path.resolve(recoDir, toolkit) : toolkit;
};

exports.mergeWebpackConfig = (ctx, clientConfig) => {
  const recoConfigFile = `${ctx.cwd}/config/reco-config.js`;
  const isDev = ctx.env.NODE_ENV === 'development';
  if (fs.existsSync(recoConfigFile)) {
    const recoConfig = require(recoConfigFile);
    const webpackConfig = recoConfig.webpack;
    if (webpackConfig) {
      const { common, env = {} } = webpackConfig;
      return webpackMerge(clientConfig, common, (isDev ? env.development : env.production) || {});
    }
  }

  return clientConfig;
};

exports.dumpConfig = (ctx, clientConfig) => {
  // dump config
  const json = Object.assign({}, clientConfig);
  const isDev = ctx.env.NODE_ENV === 'development';
  convertObject(json, []);
  const dumpFile = path.join(ctx.cwd, isDev ? 'run/webpack.development.json' : 'run/webpack.production.json');
  fs.writeFileSync(dumpFile, JSON.stringify(json, null, 2));
};

exports.installToolkit = function (pkgName, args = [], options = {}) {
  const localArgs = ['install', pkgName].concat(args);
  const registryUrl = this.helper.getRegistryByType('tnpm');
  if (registryUrl) localArgs.push('--registry', registryUrl);
  const localOpts = Object.assign({
    stdio: 'inherit'
  }, options);
  return new Promise((resolve, reject) => {
    try {
      this.helper.spawn('npm', localArgs, localOpts).then(() => {
        this.logger.info(`Install ${pkgName} succeed`);
        resolve();
      });
    } catch (err) {
      this.logger.error(`Install ${pkgName} failed, error: `, err);
      reject(err);
    }
  });
};

function match(key, arr) {
  return arr.some(x => x instanceof RegExp ? x.test(key) : x === key); // eslint-disable-line no-confusing-arrow
}

function convertObject(obj, ignore) {
  if (!is.array(ignore)) ignore = [ignore];
  for (const key of Object.keys(obj)) {
    obj[key] = convertValue(key, obj[key], ignore);
  }
  return obj;
}

function convertValue(key, value, ignore) {
  if (is.nullOrUndefined(value)) return value;

  let hit;
  for (const matchKey of ignore) {
    if (typeof matchKey === 'string' && matchKey === key) {
      hit = true;
    } else if (is.regExp(matchKey) && matchKey.test(key)) {
      hit = true;
    }
  }
  if (!hit) {
    if (is.symbol(value) || is.regExp(value)) return value.toString();
    if (is.primitive(value)) return value;
    if (is.array(value)) return value;
  }

  // only convert recursively when it's a plain object,
  // o = {}
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return convertObject(value, ignore);
  }

  // support class
  const name = value.name || 'anonymous';
  if (is.class(value)) {
    return `<Class ${name}>`;
  }

  // support generator function
  if (is.function(value)) {
    return is.generatorFunction(value) ? `<GeneratorFunction ${name}>` : `<Function ${name}>`;
  }

  const typeName = value.constructor.name;
  if (typeName) {
    if (is.buffer(value) || is.string(value)) return `<${typeName} len: ${value.length}>`;
    return `<${typeName}>`;
  }

  /* istanbul ignore next */
  return util.format(value);
}
