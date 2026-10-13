// SARA backend multi-restaurante · Postgres (Neon) · variables: DATABASE_URL, SECRET, PORT
const http=require('http'),fs=require('fs'),path=require('path'),cr=require('crypto'),{Pool}=require('pg');
const PUB=path.join(__dirname,'public'),PORT=process.env.PORT||3000;
if(!process.env.DATABASE_URL){console.error('Falta DATABASE_URL (cadena de conexión de Neon)');process.exit(1)}
const SEC=process.env.SECRET||(console.warn('Aviso: define SECRET para que las sesiones sobrevivan reinicios'),cr.randomBytes(32).toString('hex'));
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:10,idleTimeoutMillis:30000});pool.on('error',e=>console.error('pg',e.message));
// Un restaurante = una fila JSONB bloqueada con FOR UPDATE en cada cambio: los dispositivos de un mismo local se
// serializan y los locales distintos nunca se bloquean. Los cambios llegan como diferencias por elemento (no se pisan).
const init=()=>pool.query(`CREATE TABLE IF NOT EXISTS tenants(slug text PRIMARY KEY,data jsonb NOT NULL,created timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS invoices(slug text NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,no int NOT NULL,d bigint NOT NULL,data jsonb NOT NULL,PRIMARY KEY(slug,no));
 CREATE INDEX IF NOT EXISTS inv_d ON invoices(slug,d)`);
const get=async slug=>{const r=await pool.query('SELECT data FROM tenants WHERE slug=$1',[slug]);return r.rows[0]&&r.rows[0].data};
async function tx(slug,fn){const c=await pool.connect();try{await c.query('BEGIN');
 const r=await c.query('SELECT data FROM tenants WHERE slug=$1 FOR UPDATE',[slug]);if(!r.rows[0])E(404,'Restaurante no encontrado');
 const s=r.rows[0].data,out=await fn(s,c);await c.query('UPDATE tenants SET data=$2 WHERE slug=$1',[slug,s]);await c.query('COMMIT');return out}
 catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}}
const uid=()=>cr.randomBytes(5).toString('hex');
const hash=(p,salt=cr.randomBytes(8).toString('hex'))=>salt+':'+cr.scryptSync(p,salt,32).toString('hex');
const chk=(p,h)=>{const a=Buffer.from(hash(p,h.split(':')[0])),b=Buffer.from(h);return a.length===b.length&&cr.timingSafeEqual(a,b)};
const mac=b=>cr.createHmac('sha256',SEC).update(b).digest('base64url');
const sign=o=>{const b=Buffer.from(JSON.stringify(o)).toString('base64url');return b+'.'+mac(b)};
const ver=async t=>{try{const[b,g]=String(t).split('.');if(g!==mac(b))return;const o=JSON.parse(Buffer.from(b,'base64url'));if(o.e<Date.now())return;const s=await get(o.s),u=s&&s.users.find(x=>x.id===o.u);return u&&(u.tv|0)===(o.v|0)?{s,u}:undefined}catch{}};
const slugify=n=>n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,30)||'rest';
const E=(c,m)=>{throw{c,m}};
const str=(v,n)=>String(v??'').trim().slice(0,n);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
const CL=new Map(),bc=(slug,e)=>(CL.get(slug)||[]).forEach(r=>r.write('data: '+e+'\n\n'));
const RL=new Map(),lim=ip=>{const n=Date.now(),a=(RL.get(ip)||[]).filter(t=>n-t<6e4);a.push(n);RL.set(ip,a);if(a.length>15)E(429,'Demasiados intentos, espera un minuto')};
const ROLES={Mesero:'waiter',Cajero:'cashier',Cocina:'kitchen'};
const PRICE={'Básico':29,'Profesional':59,'Empresarial':99}; // precio mensual (pago simulado)
const PLAN_USERS={'Básico':2,'Profesional':6,'Empresarial':20}; // usuarios de equipo permitidos por plan (sin contar al dueño)
const tok=(s,u)=>sign({s:s.slug,u:u.id,v:u.tv|0,e:Date.now()+2592e6});
// Pago SIMULADO: solo se guarda marca + últimos 4 dígitos, jamás el número completo. Terminación 0002 = rechazada (prueba)
const card=c=>{c=c||{};const l=String(c.last4||'').replace(/\D/g,'');if(l.length!==4)E(400,'Datos de pago inválidos');if(l==='0002')E(402,'Tarjeta rechazada. Prueba con otra tarjeta.');return{brand:['Visa','Mastercard','Amex'].includes(c.brand)?c.brand:'Tarjeta',last4:l}};
const charge=(s,pl,cd)=>{const h={id:'PAY-'+uid().toUpperCase(),d:Date.now(),plan:pl,amt:PRICE[pl],card:cd,st:'Aprobado'};s.bill={plan:pl,amt:PRICE[pl],card:cd,next:Date.now()+2592e6,hist:[h].concat((s.bill&&s.bill.hist)||[]).slice(0,24)};return h};
const kick=(slug,id)=>(CL.get(slug)||new Set()).forEach(x=>{if(x.uid===id)x.end()});
// Qué colecciones del panel puede leer/escribir cada rol (el dueño todo)
const COL={menu:'id',inv:'id',tables:'n',emp:'id',res:'id',kit:'id',gas:'d',cier:'d',fac:'no'};
const PERM={cashier:['tables','kit','inv','fac','gas','cier','$'],waiter:['tables','kit'],kitchen:['kit']};
const VIEW={cashier:['menu','tables','kit','inv','fac','gas','cier','caja'],waiter:['menu','tables','kit'],kitchen:['menu','tables','kit']};

http.createServer(async(q,r)=>{
 const u=new URL(q.url,'http://x'),p=u.pathname,ip=q.headers['x-forwarded-for']||q.socket.remoteAddress;
 const J=(c,o)=>{if(!r.headersSent)r.writeHead(c,{'Content-Type':'application/json'});r.end(JSON.stringify(o))};
 try{
  let m=p.match(/^\/m\/([\w-]+)$/);
  if(m){const s=await get(m[1]);r.writeHead(s?200:404,{'Content-Type':'text/html; charset=utf-8'});if(!s)return r.end('Restaurante no encontrado');
   const cs=[...new Set(s.menu.filter(x=>x.on).map(x=>x.c))];
   return r.end(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(s.name)}</title><body style="margin:0;background:#070d1a;color:#e8eeff;font:16px system-ui;padding:24px;max-width:560px;margin:auto"><h1 style="font-weight:400">${esc(s.name)}</h1>${cs.map(c=>`<h3 style="color:#8ea2d0;letter-spacing:2px;font-size:13px;text-transform:uppercase">${esc(c)}</h3>`+s.menu.filter(x=>x.on&&x.c===c).map(x=>`<div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #16233f"><span>${esc(x.n)}</span><b>${esc(s.cur)}${(+x.p).toFixed(2)}</b></div>`).join('')).join('')}`)}
  if(!p.startsWith('/api/')){
   if(p==='/favicon.ico'){r.writeHead(204);return r.end()}
   r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return r.end(fs.readFileSync(path.join(PUB,'index.html')))}
  let b={};
  if(q.method==='POST'){let d='';for await(const c of q){d+=c;if(d.length>2e6)E(413,'Solicitud muy grande')}try{b=d?JSON.parse(d):{}}catch{E(400,'JSON inválido')}}

  if(p==='/api/register'){lim(ip);
   const n=str(b.name,50),o=str(b.owner,40),un=str(b.user,30).toLowerCase().replace(/[^a-z0-9._-]/g,''),pw=String(b.pass||'');
   if(n.length<2||!o||un.length<3||pw.length<6)E(400,'Completa los datos (usuario 3+ y contraseña 6+ caracteres)');
   const cd=card(b.card),pl=PRICE[b.plan]?b.plan:'Profesional';
   const us={id:uid(),u:un,n:o,role:'owner',h:hash(pw)};
   const s={name:n,plan:pl,tax:13,cur:'$',no:1000,ts:Date.now(),users:[us],inv:[],emp:[],res:[],kit:[],gas:[],cier:[],caja:{open:0,ini:0,ts:0},
    tables:[1,2,3,4,5,6].map(n=>({n,st:'Libre',o:[]})),
    menu:[['Pupusas revueltas','Platos',2.5],['Pollo a la plancha','Platos',9.5],['Limonada','Bebidas',2.5],['Café','Bebidas',1.75]].map(x=>({id:uid(),n:x[0],c:x[1],p:x[2],on:1}))};
   charge(s,pl,cd);
   let sl=slugify(n);
   for(;;){s.slug=sl;if((await pool.query('INSERT INTO tenants(slug,data) VALUES($1,$2) ON CONFLICT DO NOTHING',[sl,s])).rowCount)break;sl=slugify(n).slice(0,24)+'-'+uid().slice(0,4)}
   return J(200,{token:tok(s,us),slug:sl})}

  if(p==='/api/login'){lim(ip);
   const s=await get(str(b.slug,40).toLowerCase()),us=s&&s.users.find(x=>x.u===str(b.user,30).toLowerCase());
   if(!us||!chk(String(b.pass||''),us.h))E(401,'Usuario, contraseña o código de restaurante incorrectos');
   return J(200,{token:tok(s,us),slug:s.slug})}

  // ---- Sesión: el restaurante sale SIEMPRE del token, nunca del cliente ----
  const A=await ver(u.searchParams.get('k')||(q.headers.authorization||'').slice(7));
  if(!A)E(401,'Sesión inválida');
  const{s:S0,u:me}=A,role=me.role,need=(...rs)=>{if(role!=='owner'&&!rs.includes(role))E(403,'Sin permiso')};

  if(p==='/api/events'){
   r.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});r.write('retry: 2000\n\n');
   r.uid=me.id;let c=CL.get(S0.slug);if(!c)CL.set(S0.slug,c=new Set());c.add(r);
   const hb=setInterval(()=>r.write(':\n\n'),25000);q.on('close',()=>{c.delete(r);clearInterval(hb)});return}

  if(p==='/api/doc'){
   const all={rest:S0.name,tax:S0.tax,cur:S0.cur,no:S0.no,caja:S0.caja,menu:S0.menu,inv:S0.inv,tables:S0.tables,emp:S0.emp,res:S0.res,gas:S0.gas,cier:S0.cier,kit:S0.kit},d={rest:S0.name,tax:S0.tax,cur:S0.cur,no:S0.no};
   for(const k of VIEW[role]||Object.keys(all))d[k]=all[k];
   if(role==='owner'||role==='cashier')d.fac=(await pool.query('SELECT data FROM invoices WHERE slug=$1 ORDER BY d DESC LIMIT 500',[S0.slug])).rows.map(x=>x.data).reverse();
   if(role==='owner')d.users=S0.users.map(({id,u,n,role})=>({id,u,n,role}));
   return J(200,{me:{n:me.n,role},slug:S0.slug,plan:S0.plan,limit:PLAN_USERS[S0.plan]||2,bill:role==='owner'?S0.bill||null:undefined,d})}

  if(p==='/api/sync'){
   const ev=await tx(S0.slug,async(s,c)=>{let ev='sync';
    for(const k in b){
     const o=b[k]||{};
     if(PERM[role]&&!PERM[role].includes(k))E(403,'Sin permiso');
     if(k==='$'){
      if(role==='owner'){if('rest'in o){const n=str(o.rest,50);if(n.length>=2)s.name=n}if('tax'in o)s.tax=Math.min(100,Math.max(0,+o.tax||0));if('cur'in o)s.cur=str(o.cur,3)||'$'}
      if('caja'in o&&o.caja&&typeof o.caja==='object')s.caja={open:o.caja.open?1:0,ini:+o.caja.ini||0,ts:+o.caja.ts||0};
      continue}
     if(!COL[k])continue;
     const kf=COL[k],up=(Array.isArray(o.up)?o.up:[]).filter(x=>x&&typeof x==='object'&&x[kf]!==undefined),del=Array.isArray(o.del)?o.del:[];
     if(k==='fac'){
      for(const x of up){const ex=(await c.query('SELECT d FROM invoices WHERE slug=$1 AND no=$2',[s.slug,x.no])).rows[0];
       if(ex&&+ex.d!==x.d)x.no=s.no++;else s.no=Math.max(s.no,x.no+1);
       await c.query('INSERT INTO invoices(slug,no,d,data) VALUES($1,$2,$3,$4) ON CONFLICT(slug,no) DO UPDATE SET data=$4',[s.slug,x.no,x.d,x])}
      continue}
     const arr=s[k]||(s[k]=[]);
     del.forEach(id=>{const i=arr.findIndex(x=>x[kf]===id);if(i>=0)arr.splice(i,1)});
     up.forEach(x=>{if(k==='kit'){const ex=arr.find(y=>y.id===x.id);if(!ex)ev='new';else if(x.st==='Listo'&&ex.st!=='Listo')ev='ready'}const i=arr.findIndex(y=>y[kf]===x[kf]);i>=0?arr[i]=x:arr.push(x)});
     if(arr.length>5000)E(413,'Demasiados registros')}
    return ev});
   bc(S0.slug,ev);return J(200,{ok:1})}

  if(p==='/api/user'){need();return await tx(S0.slug,s=>{
   const un=str(b.u,30).toLowerCase().replace(/[^a-z0-9._-]/g,''),n=str(b.n,40),rl=ROLES[b.role],pw=String(b.pass||'');
   if(un.length<3||!n||!rl||pw.length<6)E(400,'Datos inválidos (usuario 3+, contraseña 6+)');
   if(s.users.some(x=>x.u===un))E(409,'Ese usuario ya existe en tu restaurante');
   const lim=PLAN_USERS[s.plan]||2;if(s.users.filter(x=>x.role!=='owner').length>=lim)E(403,'Tu plan '+s.plan+' permite hasta '+lim+' usuarios del equipo. Mejora tu plan para agregar más.');
   s.users.push({id:uid(),u:un,n,role:rl,h:hash(pw)})}).then(()=>J(200,{ok:1}))}
  if(p==='/api/user/del'){need();return await tx(S0.slug,s=>{const x=s.users.find(y=>y.id===b.id);if(!x||x.role==='owner')E(400,'No se puede eliminar');s.users=s.users.filter(y=>y!==x)}).then(()=>{kick(S0.slug,b.id);J(200,{ok:1})})}
  if(p==='/api/user/edit'){need();return await tx(S0.slug,s=>{const x=s.users.find(y=>y.id===b.id);if(!x)E(404,'Usuario no encontrado');let bump=0;
   if('n'in b){const n=str(b.n,40);if(!n)E(400,'Nombre requerido');x.n=n}
   if(b.pass){const pw=String(b.pass);if(pw.length<6)E(400,'Contraseña de 6+ caracteres');x.h=hash(pw);if(x.role!=='owner')bump=1}
   if(b.role&&x.role!=='owner'){const rl=ROLES[b.role];if(!rl)E(400,'Rol inválido');if(rl!==x.role){x.role=rl;bump=1}}
   if(bump)x.tv=(x.tv|0)+1;return bump}).then(bump=>{if(bump)kick(S0.slug,b.id);J(200,{ok:1})})}

  // ---- Cambio de plan con pago simulado (solo dueño) ----
  if(p==='/api/plan'){need();const pl=b.plan;if(!PRICE[pl])E(400,'Plan inválido');const cd=card(b.card);
   return await tx(S0.slug,s=>{if(pl===s.plan)E(400,'Ya tienes ese plan');const n=s.users.filter(x=>x.role!=='owner').length,l=PLAN_USERS[pl];
    if(n>l)E(409,'Tu equipo tiene '+n+' accesos y el plan '+pl+' permite '+l+'. Elimina '+(n-l)+' antes de cambiar.');s.plan=pl;charge(s,pl,cd)}).then(()=>J(200,{ok:1}))}

  E(404,'No encontrado');
 }catch(e){if(e&&e.c)J(e.c,{e:e.m});else{console.error(e);J(500,{e:'Error del servidor'})}}
}).listen(PORT,async()=>{try{await init();console.log('SARA lista en http://localhost:'+PORT)}catch(e){console.error('No se pudo conectar a Neon:',e.message);process.exit(1)}});