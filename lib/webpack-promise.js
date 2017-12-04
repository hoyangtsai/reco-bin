const ERROR = Symbol('WebpackError$err');
const STATS = Symbol('WebpackError$stats');

module.exports = webpack => (config, _opts) => {
  const opts = Object.assign({
    log: true,
    stats: {},
  }, typeof _opts === 'object' && _opts !== null ? _opts : {});
  opts.stats = Object.assign({
    colors: true,
    modules: false,
    chunkModules: false,
    errorDetails: true,
  }, typeof opts.stats === 'object' && opts.stats !== null ? opts.stats : {});

  return new Promise((resolve, reject) => webpack(config).run((err, stats) => {
    if (opts.log && stats) {
      console.log(stats.toString(opts.stats));
    }

    if (err || stats.hasErrors()) {
      reject(new WebpackError(err, stats));
    } else {
      resolve(stats);
    }
  }));
};

class WebpackError extends Error {
  constructor(err, stats) {
    super((() => {
      if (err) {
        return 'WebpackRuntimeError';
      } else if (stats.hasErrors() || stats.hasWarnings()) {
        return 'WebpackCompilationError';
      }
      return 'UnknowWebpackError';
    })());

    this.name = 'WebpackError';

    this[ERROR] = err;
    this[STATS] = stats;
  }

  err() {
    return this[ERROR];
  }

  stats() {
    return this[STATS];
  }
}
