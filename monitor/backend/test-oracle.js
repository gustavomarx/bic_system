require('dotenv').config();
const oracledb = require('oracledb');

console.log('oracledb version:', oracledb.versionString);
console.log('thin mode:', oracledb.thin);
console.log('user:', process.env.DB_USER);
console.log('connect string:', process.env.DB_CONNECT_STRING.substring(0, 80) + '...');

(async () => {
  try {
    const conn = await oracledb.getConnection({
      user:          process.env.DB_USER,
      password:      process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT_STRING,
    });
    console.log('✅ Conexão OK!');
    const result = await conn.execute('SELECT 1 FROM DUAL');
    console.log('Query OK:', result.rows);
    await conn.close();
  } catch (err) {
    console.error('❌ Erro completo:', err);
  }
})();
