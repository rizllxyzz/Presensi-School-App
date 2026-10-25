import mysql from "mysql2/promise";

export interface SchoolFact {
  content: string;
  type: "factual" | "general" | "personal";
  tags: string[];
  source: string;
}

interface Row { [key: string]: unknown }

function cfg(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function dbPath(): string {
  return `mysql://${cfg("DB_HOST", "127.0.0.1")}:${cfg("DB_PORT", "3306")}/${cfg("DB_NAME", "presensi")}`;
}

async function buildSchoolFacts(): Promise<{ facts: SchoolFact[]; students: number; anomalies: number }> {
  const pool = mysql.createPool({
    host: cfg("DB_HOST", "127.0.0.1"),
    port: Number(cfg("DB_PORT", "3306")),
    database: cfg("DB_NAME", "presensi"),
    user: cfg("DB_USER", "root"),
    password: process.env.DB_PASS || "",
    connectionLimit: 2,
  });
  const facts: SchoolFact[] = [];
  const [students] = await pool.query(`SELECT u.id,u.nama_lengkap,u.username,k.nama_kelas FROM users u LEFT JOIN kelas k ON k.id=u.kelas_id WHERE u.role='siswa' ORDER BY u.id`);
  const [attendance] = await pool.query(`SELECT user_id,tanggal,scan_type,status,is_late,late_minutes,distance_m,gps_verdict FROM attendance ORDER BY user_id,tanggal,scan_type`);
  const [izin] = await pool.query(`SELECT user_id,jenis,tanggal_mulai,tanggal_selesai,status FROM izin_requests ORDER BY id`);
  const studentRows = students as Row[];
  const attendanceRows = attendance as Row[];
  const izinRows = izin as Row[];
  const byStudent = new Map<number, Row[]>();
  for (const row of attendanceRows) { const id=Number(row.user_id); if(!byStudent.has(id)) byStudent.set(id,[]); byStudent.get(id)!.push(row); }
  let anomalies=0;
  for (const s of studentRows) {
    const id=Number(s.id), nama=String(s.nama_lengkap), kelas=String(s.nama_kelas || "tanpa kelas"), rows=byStudent.get(id)||[];
    const masuk=rows.filter(r=>r.scan_type === "masuk"), pulang=rows.filter(r=>r.scan_type === "pulang");
    const source=`student:${id}`;
    facts.push({content:`Siswa ${nama} (id ${id}, kelas ${kelas}) tercatat ${masuk.length} kali masuk dan ${pulang.length} kali pulang.`,type:"factual",tags:[`student:${id}`,"attendance-summary"],source});
    const inDays=new Set(masuk.map(r=>String(r.tanggal))), outDays=new Set(pulang.map(r=>String(r.tanggal)));
    for(const day of inDays) if(!outDays.has(day)){ anomalies++; facts.push({content:`Siswa ${nama} (id ${id}) pada ${day} tercatat MASUK tetapi TIDAK ADA catatan pulang — kemungkinan keluar sekolah tanpa scan.`,type:"factual",tags:[`student:${id}`,"anomaly",`date:${day}`],source}); }
    for(const row of rows){
      if(Number(row.is_late)===1) facts.push({content:`Siswa ${nama} (id ${id}) terlambat ${row.late_minutes ?? "?"} menit pada ${row.tanggal}.`,type:"factual",tags:[`student:${id}`,"late",`date:${row.tanggal}`],source});
      if(row.gps_verdict && row.gps_verdict !== "DITERIMA") facts.push({content:`Siswa ${nama} (id ${id}) pada ${row.tanggal}: verifikasi lokasi ${row.gps_verdict}, jarak ${row.distance_m ?? "?"} m.`,type:"factual",tags:[`student:${id}`,"location"],source});
    }
  }
  const names=new Map(studentRows.map(s=>[Number(s.id),String(s.nama_lengkap)]));
  for(const row of izinRows) facts.push({content:`Pengajuan ${row.jenis} oleh ${names.get(Number(row.user_id)) || `user ${row.user_id}`} untuk ${row.tanggal_mulai} s/d ${row.tanggal_selesai}, status ${row.status}.`,type:"factual",tags:[`student:${row.user_id}`,"izin"],source:`izin:${row.user_id}`});
  await pool.end();
  return {facts,students:studentRows.length,anomalies};
}

export async function loadIntoMemory(hmem:{add:(i:unknown)=>unknown;store?:{all:()=>{id:string;source:string}[];delete:(id:string,reason:string)=>void}}):Promise<{added:number;students:number;anomalies:number}> {
  const result=await buildSchoolFacts();
  if(hmem.store) for(const r of hmem.store.all()) if(r.source.startsWith("student:")||r.source.startsWith("izin:")) hmem.store.delete(r.id,"resync");
  for(const f of result.facts) hmem.add({content:f.content,type:f.type,tags:f.tags,source:f.source,confidence:0.9});
  return {added:result.facts.length,students:result.students,anomalies:result.anomalies};
}
