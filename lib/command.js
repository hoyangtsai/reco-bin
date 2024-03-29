
const fs = require('fs');
const path = require('path');
const debug = require('debug')('reco-bin');
const co = require('co');
const yargs = require('yargs');
const parser = require('yargs-parser');
const assert = require('assert');
const semver = require('semver');
const changeCase = require('change-case');
const delegate = require('delegates');
const helper = require('./helper');

require('colors');

const DISPATCH = Symbol('Command#dispatch');
const PARSE = Symbol('Command#parse');
const COMMANDS = Symbol('Command#commands');
const VERSION = Symbol('Command#version');
const LOGGER = Symbol('Command#logger');
const CONTEXT = Symbol('Command#context');
const HELPER = Symbol('Command#helper');

class CommonBin {
  constructor(rawArgv) {
    /**
     * original argument
     * @type {Array}
     */
    this.rawArgv = rawArgv || process.argv.slice(2);
    this.name = 'reco';
    debug('[%s] origin argument `%s`', this.constructor.name, this.rawArgv.join(' '));

    /**
     * yargs
     * @type {Object}
     */
    this.yargs = yargs(this.rawArgv);

    /**
     * parserOptions
     * @type {Object}
     * @property {Boolean} execArgv - whether extract `execArgv` to `context.execArgv`
     * @property {Boolean} removeAlias - whether remove alias key from `argv`
     * @property {Boolean} removeCamelCase - whether remove camel case key from `argv`
     */
    this.parserOptions = {
      execArgv: true,
      removeAlias: true,
      removeCamelCase: false,
    };

    // <commandName, Command>
    this[COMMANDS] = new Map();
  }

  get logger() {
    if (!this[LOGGER]) {
      this[LOGGER] = {};
      ['debug', 'info', 'log', 'warn', 'error'].forEach((level) => {
        this[LOGGER][level] = (...args) => {
          const name = this.constructor.name;
          const upperLevel = level.toUpperCase();
          switch (level) {
            case 'debug':
              args[0] = ` ${upperLevel} [${name}] ${args[0]}`;
              break;
            case 'info':
            case 'log':
              args[0] = ` ${upperLevel.green} [${name}] ${args[0]}`;
              break;
            case 'warn':
              args[0] = ` ${upperLevel.yellow} [${name}] ${args[0]}`;
              break;
            case 'error':
            default:
              args[0] = ` ${upperLevel.red} [${name}] ${args[0]}`;
              break;
          }
          console.log(...args);
        };
      });
    }
    return this[LOGGER];
  }

  /**
   * command handler, could be generator / async function / normal function which return promise
   * @param {Object} context - context object
   * @param {String} context.cwd - process.cwd()
   * @param {Object} context.argv - argv parse result by yargs, `{ _: [ 'start' ], '$0': '/usr/local/bin/reco', baseDir: 'simple'}`
   * @param {Array} context.rawArgv - the raw argv, `[ "--baseDir=simple" ]`
   * @protected
   */
  run() {
    this.showHelp();
  }

  /**
   * load sub commands
   * @param {String} fullPath - the command directory
   * @example `load(path.join(__dirname, 'command'))`
   */
  load(fullPath) {
    assert(fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory(),
      `${fullPath} should exist and be a directory`);

    // load entire directory
    const files = fs.readdirSync(fullPath);
    const names = [];
    for (const file of files) {
      if (path.extname(file) === '.js') {
        const name = path.basename(file).replace(/\.js$/, '');
        names.push(name);
        this.add(name, path.join(fullPath, file));
      }
    }

    debug('[%s] loaded command `%s` from directory `%s`',
      this.constructor.name, names, fullPath);
  }

  /**
   * add sub command
   * @param {String} name - a command name
   * @param {String|Class} target - special file path (must contains ext) or Command Class
   * @example `add('test', path.join(__dirname, 'test_command.js'))`
   */
  add(name, target) {
    // this.info(`CommonBin: add: name=${name}, target: `, target);
    assert(name, `${name} is required`);
    if (!(target.prototype instanceof CommonBin)) {
      assert(fs.existsSync(target) && fs.statSync(target).isFile(), `${target} is not a file.`);
      debug('[%s] add command `%s` from `%s`', this.constructor.name, name, target);
      target = require(target);
      if (target.prototype && target.prototype instanceof CommonBin) {
        // nothing
      } else if (typeof target === 'function') {
        target = target(this);
      } else {
        assert(target.prototype instanceof CommonBin,
          'command class should be sub class of CommonBin');
      }
    }
    this[COMMANDS].set(name, target);
    target.alias && this.alias(target.alias, name);
  }

  /**
   * alias an existing command
   * @param {String} alias - alias command
   * @param {String} name - exist command
   */
  alias(alias, name) {
    assert(alias, 'alias command name is required');
    assert(this[COMMANDS].has(name), `${name} should be added first`);
    debug('[%s] set `%s` as alias of `%s`', this.constructor.name, alias, name);
    this[COMMANDS].set(alias, this[COMMANDS].get(name));
  }

  /**
   * start point of bin process
   */
  start() {
    co(function* () {
      // replace `--get-yargs-completions` to our KEY, so yargs will not block our DISPATCH
      const index = this.rawArgv.indexOf('--get-yargs-completions');
      if (index !== -1) {
        // bash will request as `--get-yargs-completions my-git remote add`, so need to remove 2
        this.rawArgv.splice(index, 2, `--AUTO_COMPLETIONS=${this.rawArgv.join(',')}`);
      }
      yield this[DISPATCH]();
    }.bind(this)).catch(this.errorHandler.bind(this));
  }

  /**
   * default error hander
   * @param {Error} err - error object
   * @protected
   */
  errorHandler(err) {
    console.error(`⚠️  ${err.name}: ${err.message}`.red);
    console.error('⚠️  Command Error, enable `DEBUG=reco-bin` for detail'.red);
    debug('args %s', process.argv.slice(3));
    debug(err.stack);
    process.exit(1);
  }

  /**
   * print help message to console
   * @param {String} [level=log] - console level
   */
  showHelp(level = 'log') {
    this.yargs.showHelp(level);
  }

  /**
   * shortcut for yargs.options
   * @param  {Object} opt - an object set to `yargs.options`
   */
  set options(opt) {
    this.yargs.options(opt);
  }

  /**
   * shortcut for yargs.usage
   * @param  {String} usage - usage info
   */
  set usage(usage) {
    this.yargs.usage(usage);
  }

  /**
   * helper function
   * @type {Object}
   */
  get helper() {
    if (!this[HELPER]) {
      Object.keys(helper).forEach((key) => {
        if (typeof helper[key] === 'function') {
          helper[key] = helper[key].bind(this);
        }
      });
      this[HELPER] = helper;
    }
    return this[HELPER];
  }

  set version(ver) {
    this[VERSION] = ver;
  }

  get version() {
    return this[VERSION];
  }

  /**
   * dispatch command, either `subCommand.exec` or `this.run`
   * @param {Object} context - context object
   * @param {String} context.cwd - process.cwd()
   * @param {Object} context.argv - argv parse result by yargs, `{ _: [ 'start' ], '$0': '/usr/local/bin/reco-bin', baseDir: 'simple'}`
   * @param {Array} context.rawArgv - the raw argv, `[ "--baseDir=simple" ]`
   * @private
   */
  * [DISPATCH]() {
    // define --help and --version by default
    this.yargs
      // .reset()
      .completion()
      .help()
      .version()
      .wrap(120)
      .alias('h', 'help')
      .alias('v', 'version')
      .group(['help', 'version'], 'Global Options:');

    // get parsed argument without handling helper and version
    const parsed = yield this[PARSE](this.rawArgv);
    const commandName = parsed._[0];

    if (parsed.version && this.version) {
      console.log(this.version);
      return;
    }

    // if sub command exist
    if (this[COMMANDS].has(commandName)) {
      const Command = this[COMMANDS].get(commandName);
      const rawArgv = this.rawArgv.slice();
      rawArgv.splice(rawArgv.indexOf(commandName), 1);

      debug('[%s] dispatch to subcommand `%s` -> `%s` with %j', this.constructor.name, commandName, Command.name, rawArgv);
      const command = new Command(rawArgv);
      yield command[DISPATCH]();
      return;
    }

    // register command for printing
    for (const [name, Command] of this[COMMANDS].entries()) {
      this.yargs.command(name, Command.prototype.description || '');
    }

    debug('[%s] exec run command', this.constructor.name);
    const context = this.context;

    // print completion for bash
    if (context.argv.AUTO_COMPLETIONS) {
      // slice to remove `--AUTO_COMPLETIONS=` which we append
      this.yargs.getCompletion(this.rawArgv.slice(1), (completions) => {
        // console.log('%s', completions)
        completions.forEach(x => console.log(x));
      });
    } else {
      // handle by self
      yield this.helper.callFn(this.run, [context], this);
    }
  }

   /**
   * getter of context, default behavior is remove `help` / `h` / `version`
   * @return {Object} context - { cwd, env, argv, rawArgv }
   * @protected
   */
  get ctx() {
    return this.context;
  }

  /**
   * getter of context, default behavior is remove `help` / `h` / `version`
   * @return {Object} context - { cwd, env, argv, rawArgv }
   * @protected
   */
  get context() {
    if (!this[CONTEXT]) {
      const argv = this.yargs.argv;
      const context = {
        argv,
        cwd: process.cwd(),
        env: Object.assign({}, process.env),
        rawArgv: this.rawArgv,
      };

      argv.help = undefined;
      argv.h = undefined;
      argv.version = undefined;
      argv.v = undefined;

      // remove alias result
      if (this.parserOptions.removeAlias) {
        const aliases = this.yargs.getOptions().alias;
        for (const key of Object.keys(aliases)) {
          aliases[key].forEach((item) => {
            argv[item] = undefined;
          });
        }
      }

      // remove camel case result
      if (this.parserOptions.removeCamelCase) {
        for (const key of Object.keys(argv)) {
          if (key.includes('-')) {
            argv[changeCase.camel(key)] = undefined;
          }
        }
      }

      // extract execArgv
      if (this.parserOptions.execArgv) {
        // extract from command argv
        let { debugPort, debugOptions, execArgvObj } = this.helper.extractExecArgv(argv); // eslint-disable-line prefer-const

        // extract from WebStorm env `$NODE_DEBUG_OPTION`
        if (context.env.NODE_DEBUG_OPTION) {
          console.log('Use $NODE_DEBUG_OPTION: %s', context.env.NODE_DEBUG_OPTION);
          const argvFromEnv = parser(context.env.NODE_DEBUG_OPTION);
          const obj = this.helper.extractExecArgv(argvFromEnv);
          debugPort = obj.debugPort || debugPort;
          Object.assign(debugOptions, obj.debugOptions);
          Object.assign(execArgvObj, obj.execArgvObj);
        }

        // `--expose_debug_as` is not supported by 7.x+
        if (execArgvObj.expose_debug_as && semver.gte(process.version, '7.0.0')) {
          console.warn(`Node.js runtime is ${process.version}, and inspector protocol is not support --expose_debug_as`.yellow);
        }

        // remove from origin argv
        for (const key of Object.keys(execArgvObj)) {
          argv[key] = undefined;
          argv[changeCase.camel(key)] = undefined;
        }

        // only exports execArgv when any match
        if (Object.keys(execArgvObj).length) {
          context.execArgv = this.helper.unparseArgv(execArgvObj);
          context.execArgvObj = execArgvObj;
          context.debugOptions = debugOptions;
          context.debugPort = debugPort;
        }
      }

      this[CONTEXT] = context;
    }
    return this[CONTEXT];
  }

  [PARSE](rawArgv) {
    return new Promise((resolve, reject) => {
      /* istanbul ignore next */
      this.yargs.parse(rawArgv, (err, argv) => (err ? reject(err) : resolve(argv)));
    });
  }
}

delegate(CommonBin.prototype, 'logger')
  .method('debug')
  .method('info')
  .method('log')
  .method('warn')
  .method('error');

module.exports = CommonBin;
