// start-mcp.js
const { spawn } = require("child_process");
const mysql = require("mysql2/promise");
const net = require("net");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

// Cargar configuración desde el archivo mcp-config.env
const configPath = path.join(__dirname, "mcp-config.env");
const envConfig = dotenv.parse(fs.readFileSync(configPath));

// Función para obtener un valor del archivo de configuración o usar un valor por defecto
function getConfig(key, defaultValue = "") {
  return envConfig[key] || process.env[key] || defaultValue;
}

/**
 * Espera a que un puerto TCP esté escuchando
 */
async function waitForPort(port, host = "127.0.0.1", timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const s = net
          .createConnection(port, host)
          .once("connect", () => {
            s.end();
            resolve();
          })
          .once("error", reject);
      });
      return;
    } catch (_) {
      // si falla, esperamos medio segundo y reintentamos
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Timeout esperando a ${host}:${port}`);
}

async function introspectDatabase() {
  console.error("🔍 Conectando para inspección…");
  const conn = await mysql.createConnection({
    host: getConfig("MYSQL_HOST", "127.0.0.1"),
    port: parseInt(getConfig("MYSQL_PORT", "3306")),
    user: getConfig("MYSQL_USER"),
    password: getConfig("MYSQL_PASS"),
    database: getConfig("MYSQL_DB"),
  });

  await conn.end();
  console.error("✅ Inspección completada.");
}

async function main() {
  // 1) Arrancamos el túnel SSH
  const sshHost = getConfig("SSH_HOST");
  const sshUser = getConfig("SSH_USER");
  const sshPortMapping = getConfig("SSH_PORT_MAPPING", "3306:127.0.0.1:3306");
  
  const ssh = spawn(
    "ssh",
    [
      "-N",
      "-L",
      sshPortMapping,
      `${sshUser}@${sshHost}`,
    ],
    { stdio: "inherit", shell: false }
  );

  ssh.on("error", (err) => {
    console.error("❌ Error iniciando túnel SSH:", err);
    process.exit(1);
  });
  ssh.on("close", (code) => {
    console.error(`🔌 Túnel SSH cerrado (code ${code})`);
    process.exit(code);
  });

  // 2) Esperamos a que 127.0.0.1:3306 esté listo
  console.error("⏳ Esperando a que el túnel abra el puerto 3306…");
  await waitForPort(parseInt(getConfig("MYSQL_PORT", "3306")), getConfig("MYSQL_HOST", "127.0.0.1"), 15000);

  // 3) Hacemos la introspección
  await introspectDatabase();

  // 4) Arrancamos el MCP-Server
  console.error("🔒 Iniciando MCP-Server…");
  const serverScript = path.join(
    __dirname,
    "node_modules",
    "@benborla29",
    "mcp-server-mysql",
    "dist",
    "index.js"
  );

  // Configurar el entorno para el servidor MCP
  const serverEnv = {
    ...process.env,
  };

  // Añadir todas las variables del archivo de configuración al entorno
  Object.keys(envConfig).forEach(key => {
    serverEnv[key] = envConfig[key];
  });

  const server = spawn("node", [serverScript], {
    stdio: "inherit",
    cwd: __dirname,
    env: serverEnv,
  });

  server.on("error", (err) => {
    console.error("❌ Error arrancando MCP-Server:", err);
    ssh.kill();
    process.exit(1);
  });
  server.on("exit", (code) => {
    console.error(
      `⚠️ MCP-Server finalizó con código ${code} — presiona Ctrl+C para cerrar el túnel.`
    );
  });
}

main().catch((err) => {
  console.error("❌ ERROR_FATAL:", err);
  process.exit(1);
});
