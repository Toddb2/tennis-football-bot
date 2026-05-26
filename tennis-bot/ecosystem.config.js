module.exports = {
  apps: [
    {
      name: 'tennis-bot',
      script: 'src/index.js',
      cwd: __dirname,

      autorestart: true,
      stop_exit_codes: [0],
      watch: false,

      env_file: '.env',

      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/pm2-error.log',
      out_file:   'logs/pm2-out.log',
      merge_logs: true,
      max_size:   '10M',
      retain:     14,

      kill_timeout: 15000,
    },
  ],
};
