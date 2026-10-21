// One-time, non-destructive copy of legacy friendship submissions into their canonical table.
const mysql=require('mysql2/promise');
(async()=>{const p=mysql.createPool({host:process.env.MYSQL_HOST,port:process.env.MYSQL_PORT,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE});try{
 const [a]=await p.query('SHOW COLUMNS FROM users'),[b]=await p.query('SHOW COLUMNS FROM friend_survey');const have=new Set(b.map(x=>x.Field));const cols=a.map(x=>x.Field).filter(x=>x!=='id'&&have.has(x));
 const select=cols.map(x=>x==='serial_number'?"COALESCE(u.serial_number,CONCAT('Flegacy',u.id))":'u.`'+x+'`');
 const [r]=await p.query(`INSERT INTO friend_survey (${cols.map(x=>'`'+x+'`').join(',')}) SELECT ${select.join(',')} FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.survey_type='friend' AND NOT EXISTS (SELECT 1 FROM friend_survey f WHERE f.account_id=u.account_id OR f.serial_number=COALESCE(u.serial_number,CONCAT('Flegacy',u.id)))`);
 console.log('Legacy friendship submissions copied:',r.affectedRows);
}finally{await p.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
