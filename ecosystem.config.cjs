module.exports = {
  apps: [
    {
      name: "bots-employee-x-prod",
      script: "./dist/index.js",
      exec_mode: "fork",
      interpreter: "node@22.21.1",
      env: {
        NODE_ENV: "prod"
      }
    },
    {
      name: "bots-employee-x-mcp",
      script: "./dist/mcp/server.js",
      exec_mode: "fork",
      interpreter: "node@22.21.1",
      env: {
        NODE_ENV: "prod",
        MCP_PORT: "3979"
      }
    }
  ]
};
