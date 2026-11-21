import {randomUUID} from 'node:crypto';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';

export const maxAttachment = 20 * 1024 * 1024;

function imageType(buffer) {
  if (buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.subarray(0,3).equals(Buffer.from([255,216,255]))) return 'image/jpeg';
  if (buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return 'image/webp';
  if (['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6))) return 'image/gif';
  return null;
}

export async function storeAttachment(db, dir, room, filename, body) {
  const name = path.basename(String(filename || '附件').replaceAll('\\','/')).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,180) || '附件';
  const id = randomUUID();
  const type = imageType(body);
  const ext = type ? '.'+type.split('/')[1].replace('jpeg','jpg') : path.extname(name).replace(/[^.\w-]/g,'').slice(0,16);
  const folder = path.resolve(dir,'attachments');
  await mkdir(folder,{recursive:true,mode:0o700});
  const storedPath = path.join(folder,id+ext);
  await writeFile(storedPath,body,{flag:'wx',mode:0o600});
  db.prepare('INSERT INTO attachment VALUES(?,?,?,?,?,?)').run(id,room,name,storedPath,type,body.length);
  return {id,name,image:!!type,size:body.length};
}

export function getAttachment(db, room, id) {
  return db.prepare('SELECT * FROM attachment WHERE id=? AND room=?').get(id,room);
}

export async function serveAttachment(res, file) {
  const contents = await readFile(file.path);
  res.writeHead(200,{
    'Content-Type': file.type || 'application/octet-stream',
    'X-Content-Type-Options':'nosniff',
    'Content-Disposition': (file.type ? 'inline' : 'attachment')+"; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/['()]/g,c=>'%'+c.charCodeAt(0).toString(16)),
    'Cache-Control':'private, max-age=3600'
  });
  res.end(contents);
}
