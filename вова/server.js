import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTelegramBot } from "./telegram-bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(__dirname, "data"), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, "data", "service.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'manager', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, first_date TEXT NOT NULL, comments TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS repairs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE NOT NULL, client_id INTEGER, client_name TEXT NOT NULL, phone TEXT,
 device TEXT NOT NULL, model TEXT, fault TEXT, work TEXT, repair_cost REAL DEFAULT 0, parts_cost REAL DEFAULT 0,
 received TEXT NOT NULL, due TEXT, technician TEXT, status TEXT DEFAULT 'Новый', comments TEXT DEFAULT '',
 photos TEXT DEFAULT '[]', FOREIGN KEY(client_id) REFERENCES clients(id)
);
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sku TEXT UNIQUE, category TEXT,
 quantity REAL DEFAULT 0, purchase_price REAL DEFAULT 0, sale_price REAL DEFAULT 0, supplier TEXT, received TEXT,
 min_stock REAL DEFAULT 0, description TEXT DEFAULT '', photo TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS parts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sku TEXT UNIQUE, compatible TEXT,
 category TEXT, quantity REAL DEFAULT 0, purchase_price REAL DEFAULT 0, sale_price REAL DEFAULT 0, supplier TEXT,
 min_stock REAL DEFAULT 0, location TEXT, comment TEXT DEFAULT '', photo TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS repair_parts (repair_id INTEGER, part_id INTEGER, quantity REAL NOT NULL, PRIMARY KEY(repair_id, part_id),
 FOREIGN KEY(repair_id) REFERENCES repairs(id) ON DELETE CASCADE, FOREIGN KEY(part_id) REFERENCES parts(id));
CREATE TABLE IF NOT EXISTS stock_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, item_kind TEXT NOT NULL,
 item_id INTEGER NOT NULL, item_name TEXT NOT NULL, quantity REAL NOT NULL, cost REAL DEFAULT 0, supplier TEXT DEFAULT '',
 reason TEXT DEFAULT '', responsible TEXT, date TEXT NOT NULL, comment TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS operation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, description TEXT NOT NULL,
 actor TEXT DEFAULT 'Администратор', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, quantity REAL, amount REAL, date TEXT, customer TEXT,
 FOREIGN KEY(product_id) REFERENCES products(id));
`);
const productColumns = db.prepare("PRAGMA table_info(products)").all().map(column => column.name);
if (!productColumns.includes("repair_price")) db.exec("ALTER TABLE products ADD COLUMN repair_price REAL DEFAULT 0");

const seedSetting = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)");
seedSetting.run("centerName", "Apple vinny");
seedSetting.run("currency", "UAH");
seedSetting.run("role", "Администратор");
const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
if (!userCount) db.prepare("INSERT INTO users(name,role) VALUES (?,?)").run("Администратор", "Администратор");
const repairCount = db.prepare("SELECT COUNT(*) AS n FROM repairs").get().n;
if (!repairCount) {
  db.prepare("INSERT INTO clients(name,phone,email,first_date,comments) VALUES (?,?,?,?,?)").run("Иван Петренко", "+380 67 123 45 67", "ivan@example.com", new Date().toISOString(), "");
  db.prepare(`INSERT INTO repairs(number,client_id,client_name,phone,device,model,fault,work,repair_cost,parts_cost,received,due,technician,status)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("R-" + Date.now(), 1, "Иван Петренко", "+380 67 123 45 67", "iPhone", "14 Pro", "Не работает экран", "Замена дисплея", 1800, 650, new Date().toISOString(), new Date(Date.now()+3*86400000).toISOString(), "Администратор", "В процессе ремонта");
}

function json(res, data, status = 200) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let text="";
    req.on("data", c => { text += c; if (text.length > 5e6) req.destroy(); });
    req.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error("Некорректный JSON")); } });
  });
}
function log(type, description, actor="Администратор") {
  db.prepare("INSERT INTO operation_log(type,description,actor,created_at) VALUES (?,?,?,?)").run(type, description, actor, new Date().toISOString());
}
function validateWarranty(data) {
  if (!data.received || !data.due) return;
  const start = new Date(data.received);
  const end = new Date(data.due);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) throw new Error("Некорректная дата гарантии");
  const maxEnd = new Date(start);
  maxEnd.setMonth(maxEnd.getMonth() + 1);
  if (end < start) throw new Error("Конец гарантии не может быть раньше начала");
  if (end > maxEnd) throw new Error("Срок гарантии не может превышать один месяц");
}
const readAll = table => db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all();
const one = (table,id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

const publicDir = path.join(__dirname, "public");
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req,res,url);
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!path.extname(file)) file = "/index.html";
    const target = path.join(publicDir, path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, ""));
    if (!existsSync(target)) return json(res,{error:"Файл не найден"},404);
    const ext = path.extname(target);
    const types = {".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"};
    res.writeHead(200,{"Content-Type":(types[ext] || "application/octet-stream")+"; charset=utf-8"});
    res.end(await readFile(target));
  } catch (e) {
    json(res,{error:e.message || "Ошибка сервера"},500);
  }
});

async function api(req,res,url) {
  const method=req.method;
  const parts=url.pathname.split("/").filter(Boolean);
  const resource=parts[1], id=parts[2] ? Number(parts[2]) : null;
  if (resource === "settings" && method === "GET") {
    return json(res,Object.fromEntries(db.prepare("SELECT key,value FROM settings").all().map(r => [r.key,r.value])));
  }
  if (resource === "settings" && method === "PUT") { const data=await body(req); const up=db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"); db.exec("BEGIN"); for(const [k,v] of Object.entries(data)) up.run(k,String(v)); db.exec("COMMIT"); log("Настройки","Изменены настройки системы"); return json(res, data); }
  if (resource === "dashboard" && method === "GET") {
    const repairs=readAll("repairs");
    const products=readAll("products"), partsStock=readAll("parts");
    const low=[...products,...partsStock].filter(x => Number(x.quantity)<=Number(x.min_stock));
    const inventory=products.reduce((s,x)=>s+x.quantity*x.purchase_price,0)+partsStock.reduce((s,x)=>s+x.quantity*x.purchase_price,0);
    return json(res,{
      counts:{repairs:repairs.length,new:repairs.filter(r=>r.status==="Новый").length,inProgress:repairs.filter(r=>["Принят в работу","Диагностика","В процессе ремонта","Ожидает запчасти"].includes(r.status)).length,done:repairs.filter(r=>["Готов","Выдан клиенту"].includes(r.status)).length,products:products.length,parts:partsStock.length,low:low.length,inventory},
      latestRepairs:repairs.slice(0,8), latestOps:readAll("stock_operations").slice(0,8), lowItems:low.slice(0,8)
    });
  }
  if (resource === "global-search" && method === "GET") {
    const q=(url.searchParams.get("q")||"").trim().toLowerCase();
    if(!q) return json(res,[]);
    const list=[...readAll("repairs").map(x=>({...x,type:"Ремонт",label:x.number+" · "+x.client_name})),
      ...readAll("products").map(x=>({...x,type:"Товар",label:x.name+" · "+(x.sku||"")})),
      ...readAll("parts").map(x=>({...x,type:"Запчасть",label:x.name+" · "+(x.sku||"")})),
      ...readAll("clients").map(x=>({...x,type:"Клиент",label:x.name+" · "+(x.phone||"")}))];
    return json(res,list.filter(x=>Object.values(x).join(" ").toLowerCase().includes(q)).slice(0,20));
  }
  const tables={clients:"clients",repairs:"repairs",products:"products",parts:"parts",users:"users",sales:"sales"};
  const table=tables[resource];
  if(table) {
    if(method==="GET" && !id) return json(res,readAll(table));
    if(method==="GET" && id) return json(res,one(table,id)||{});
    if(method==="POST") {
      const data=await body(req);
      if(resource==="repairs") validateWarranty(data);
      if(resource==="repairs" && !data.number) data.number="R-"+Date.now().toString().slice(-10);
      const cols=Object.keys(data).filter(k=>data[k]!==undefined);
      const placeholders=cols.map(()=>"?").join(",");
      const result=db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${placeholders})`).run(...cols.map(k=>typeof data[k]==="object"?JSON.stringify(data[k]):data[k]));
      const created=one(table,result.lastInsertRowid);
      log(resource==="repairs"?"Ремонт":"CRUD",resource==="repairs"?`Создан ремонт ${created.number}`:`Создана запись в разделе ${resource}`);
      return json(res,created,201);
    }
    if(method==="PUT" && id) {
      const data=await body(req); const old=one(table,id);
      if(resource==="repairs") validateWarranty({...old,...data});
      const cols=Object.keys(data).filter(k=>data[k]!==undefined);
      db.prepare(`UPDATE ${table} SET ${cols.map(k=>k+"=?").join(",")} WHERE id=?`).run(...cols.map(k=>typeof data[k]==="object"?JSON.stringify(data[k]):data[k]),id);
      const changed=one(table,id);
      if(resource==="repairs" && old && old.status!==changed.status) log("Статус ремонта",`Ремонт ${changed.number}: ${old.status} → ${changed.status}`);
      else log(resource==="repairs"?"Ремонт":"CRUD",`Изменена запись #${id}`);
      return json(res,changed);
    }
    if(method==="DELETE" && id) { const old=one(table,id); db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); log("Удаление",`Удалена запись #${id} из ${resource}`); return json(res,{ok:true}); }
  }
  if(resource==="stock" && method==="GET") return json(res,[...readAll("products").map(x=>({...x,itemKind:"product"})),...readAll("parts").map(x=>({...x,itemKind:"part"}))]);
  if(resource==="stock-operations" && method==="GET") return json(res,readAll("stock_operations"));
  if(resource==="stock-operations" && method==="POST") {
    const data=await body(req); const table=data.itemKind==="product"?"products":"parts"; const item=one(table,data.itemId);
    if(!item) return json(res,{error:"Позиция не найдена"},404);
    const delta=data.kind==="receipt"?Number(data.quantity):-Number(data.quantity);
    if(Number(item.quantity)+delta<0) return json(res,{error:"Недостаточно остатка. Отрицательный остаток запрещён."},400);
    db.prepare(`UPDATE ${table} SET quantity=? WHERE id=?`).run(Number(item.quantity)+delta,item.id);
    db.prepare("INSERT INTO stock_operations(kind,item_kind,item_id,item_name,quantity,cost,supplier,reason,responsible,date,comment) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(data.kind,data.itemKind,item.id,item.name,Number(data.quantity),Number(data.cost||0),data.supplier||"",data.reason||"",data.responsible||"Администратор",data.date||new Date().toISOString(),data.comment||"");
    log(data.kind==="receipt"?"Поступление":"Списание",`${data.kind==="receipt"?"Поступило":"Списано"} ${data.quantity} × ${item.name}`);
    return json(res,{ok:true,quantity:Number(item.quantity)+delta},201);
  }
  if(resource==="repair-parts" && method==="POST") {
    const data=await body(req); const part=one("parts",data.partId); const qty=Number(data.quantity||1);
    if(!part || part.quantity<qty) return json(res,{error:"Недостаточно запчастей на складе"},400);
    db.prepare("INSERT INTO repair_parts(repair_id,part_id,quantity) VALUES (?,?,?) ON CONFLICT(repair_id,part_id) DO UPDATE SET quantity=quantity+excluded.quantity").run(data.repairId,data.partId,qty);
    db.prepare("UPDATE parts SET quantity=quantity-? WHERE id=?").run(qty,data.partId);
    log("Использование запчастей",`В ремонт #${data.repairId} добавлено ${qty} × ${part.name}`);
    return json(res,{ok:true});
  }
  if(resource==="operations" && method==="GET") return json(res,[...readAll("operation_log")]);
  if(resource==="backup" && method==="GET") {
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Content-Disposition":"attachment; filename=service-backup.json"});
    return res.end(JSON.stringify({createdAt:new Date().toISOString(), settings:Object.fromEntries(db.prepare("SELECT key,value FROM settings").all().map(r=>[r.key,r.value])), clients:readAll("clients"), repairs:readAll("repairs"), products:readAll("products"), parts:readAll("parts"), operations:readAll("operation_log")}));
  }
  json(res,{error:"Маршрут не найден"},404);
}

const port=Number(process.env.PORT||3000);
server.listen(port, () => console.log(`Service Management System: http://localhost:${port}`));
startTelegramBot();
