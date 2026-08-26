const path = require("path");

module.exports = {
  apps: [
    {
      name: "ben-budget-dashboard",
      script: path.join(__dirname, "server.js"),
      // Pin cwd and log paths to this file's directory so a reboot-time
      // resurrect doesn't resolve them against whatever cwd PM2 happens to have.
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
      },
      error_file: path.join(__dirname, "logs", "error.log"),
      out_file: path.join(__dirname, "logs", "output.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
