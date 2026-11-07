import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)\=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const db = new DatabaseSync(path.join(root, "data", "service.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS telegram_users (
  chat_id TEXT PRIMARY KEY, telegram_name TEXT, role TEXT DEFAULT 'admin', active INTEGER DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS financial_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('income','expense')),
  category TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount >= 0),
  description TEXT DEFAULT '',
  occurred_at TEXT NOT NULL,
  source TEXT DEFAULT 'telegram',
  external_key TEXT UNIQUE,
  telegram_chat_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_sent_reports (
  period TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sent_at TEXT NOT NULL
);
`);

const token = process.env.TELEGRAM_BOT_TOKEN;
const configuredAdmin = process.env.ADMIN_TELEGRAM_ID;
if (configuredAdmin) {
  db.prepare("INSERT OR IGNORE INTO telegram_users(chat_id,telegram_name,role,active,created_at) VALUES (?,?,?,?,?)")
    .run(configuredAdmin, "Администратор", "admin", 1, new Date().toISOString());
}

const getSetting = (key, fallback) => db.prepare("SELECT value FROM telegram_settings WHERE key=?").get(key)?.value ?? fallback;
const uaDate = date => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", year:"numeric", month:"2-digit", day:"2-digit" }).format(date);
const uaNowParts = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Kyiv", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(new Date());
  const map = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type,p.value]));
  return {...map, hour:Number(map.hour), day:Number(map.day), month:Number(map.month), year:Number(map.year)};
};
const inPeriod = (value, start, end) => String(value || "").slice(0,10) >= start && String(value || "").slice(0,10) <= end;
const money = amount => new Intl.NumberFormat("uk-UA", { style:"currency", currency:process.env.BOT_CURRENCY || "UAH", maximumFractionDigits:0 }).format(Number(amount || 0));
const escapeHtml = value => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function periodRange(type) {
  const now = uaNowParts();
  const date = (year, month, day) => `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  if (type === "today") return [date(now.year,now.month,now.day),date(now.year,now.month,now.day)];
  if (type === "lastmonth") {
    const d = new Date(Date.UTC(now.year, now.month - 2, 1));
    const y=d.getUTCFullYear(), m=d.getUTCMonth()+1;
    const last=new Date(Date.UTC(y,m,0)).getUTCDate();
    return [date(y,m,1),date(y,m,last)];
  }
  if (type === "month") {
    const last=new Date(Date.UTC(now.year,now.month,0)).getUTCDate();
    return [date(now.year,now.month,1),date(now.year,now.month,last)];
  }
  if (type === "year") return [date(now.year,1,1),date(now.year,12,31)];
  const end=new Date(Date.UTC(now.year,now.month-1,now.day));
  const start=new Date(end); start.setUTCDate(start.getUTCDate()-6);
  return [date(start.getUTCFullYear(),start.getUTCMonth()+1,start.getUTCDate()),date(end.getUTCFullYear(),end.getUTCMonth()+1,end.getUTCDate())];
}

function hasAccess(chatId) {
  const row=db.prepare("SELECT * FROM telegram_users WHERE chat_id=? AND active=1").get(String(chatId));
  return Boolean(row && row.role === "admin");
}

function totals(start,end) {
  const repairs=db.prepare("SELECT repair_cost, parts_cost, status FROM repairs WHERE received IS NOT NULL").all()
    .filter(r => inPeriod(r.received,start,end));
  const completed=repairs.filter(r => ["Готов","Выдан клиенту"].includes(r.status));
  const repairIncome=completed.reduce((sum,r)=>sum+Math.max(0,Number(r.repair_cost||0)),0);
  const usedParts=db.prepare("SELECT quantity FROM repair_parts rp JOIN repairs r ON r.id=rp.repair_id WHERE r.received IS NOT NULL").all();
  const sales=db.prepare("SELECT quantity, amount, date FROM sales").all().filter(s=>inPeriod(s.date,start,end));
  const productIncome=sales.reduce((sum,s)=>sum+Number(s.amount||0),0);
  const productCount=sales.reduce((sum,s)=>sum+Number(s.quantity||0),0);
  const operations=db.prepare("SELECT type,category,amount,occurred_at FROM financial_operations").all().filter(o=>inPeriod(o.occurred_at,start,end));
  const manualIncome=operations.filter(o=>o.type==="income").reduce((sum,o)=>sum+Number(o.amount||0),0);
  const expenses=operations.filter(o=>o.type==="expense").reduce((sum,o)=>sum+Number(o.amount||0),0);
  const stockPurchases=db.prepare("SELECT quantity,cost,date FROM stock_operations WHERE kind='receipt'").all().filter(o=>inPeriod(o.date,start,end));
  const purchaseExpenses=stockPurchases.reduce((sum,o)=>sum+Number(o.quantity||0)*Number(o.cost||0),0);
  const usedPartsCount=usedParts.reduce((sum,p)=>sum+Number(p.quantity||0),0);
  return {repairIncome,productIncome,manualIncome,income:repairIncome+productIncome+manualIncome,
    expenses:expenses+purchaseExpenses,purchaseExpenses,manualExpenses:expenses,productCount,usedPartsCount,
    repairs:repairs.length,completed:completed.length,inProgress:repairs.filter(r=>!["Готов","Выдан клиенту","Отменён"].includes(r.status)).length,cancelled:repairs.filter(r=>r.status==="Отменён").length};
}

function report(rangeName="month") {
  const [start,end]=periodRange(rangeName==="lastmonth"?"lastmonth":rangeName);
  const t=totals(start,end), result=t.income-t.expenses;
  const avg=t.completed?t.repairIncome/t.completed:0;
  return `<b>📊 ФИНАНСОВЫЙ ОТЧЁТ</b>\nПериод: <b>${escapeHtml(start)}</b> — <b>${escapeHtml(end)}</b>\n\n` +
    `<b>💰 ДОХОДЫ</b>\n• Ремонты: ${money(t.repairIncome)}\n• Продажа товаров: ${money(t.productIncome)}\n• Прочие поступления: ${money(t.manualIncome)}\n<b>Итого: ${money(t.income)}</b>\n\n` +
    `<b>💸 РАСХОДЫ</b>\n• Закупки со склада: ${money(t.purchaseExpenses)}\n• Остальные расходы: ${money(t.manualExpenses)}\n<b>Итого: ${money(t.expenses)}</b>\n\n` +
    `<b>📈 ФИНАНСОВЫЙ РЕЗУЛЬТАТ</b>\n• Поступления: ${money(t.income)}\n• Расходы: ${money(t.expenses)}\n• Разница: ${money(result)}\n• Продано товаров: ${t.productCount}\n• Использовано запчастей: ${t.usedPartsCount}\n\n` +
    `<b>🔧 РЕМОНТЫ</b>\n• Всего: ${t.repairs}\n• Завершено: ${t.completed}\n• В процессе: ${t.inProgress}\n• Отменено: ${t.cancelled}\n• Средний доход: ${money(avg)}\n\n` +
    `За период поступило ${money(t.income)}, потрачено ${money(t.expenses)}, разница составила ${money(result)}.`;
}

async function telegram(method, payload={}) {
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if (!response.ok) throw new Error(`Telegram API ${method}: ${response.status}`);
  const data=await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

async function send(chatId,text,keyboard) {
  return telegram("sendMessage",{chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true,...(keyboard?{reply_markup:keyboard}:{})});
}
function menu() {
  return {keyboard:[[ {text:"📊 Финансовая статистика"},{text:"💰 Доходы"}],[{text:"💸 Расходы"},{text:"🔧 Статистика ремонтов"}],[{text:"📦 Склад и закупки"},{text:"📅 Отчёт за месяц"}],[{text:"⚙️ Настройки"}]],resize_keyboard:true};
}

const pending=new Map();
function parseAmount(text) {
  const match=String(text).replace(",",".").match(/(\d+(?:[.,]\d{1,2})?)\s*(?:грн|uah|₴|\b)/i);
  return match?Math.round(Number(match[1].replace(",","."))*100)/100:null;
}
function detectCategory(text,type) {
  const lower=text.toLowerCase();
  if(type==="expense"){
    if(/запчаст/.test(lower)) return "Закупка запчастей";
    if(/товар/.test(lower)) return "Закупка товаров";
    if(/аренд/.test(lower)) return "Аренда помещения";
    if(/зарплат/.test(lower)||/сотрудник/.test(lower)) return "Зарплаты";
    if(/коммун|свет|вода/.test(lower)) return "Коммунальные услуги";
    if(/достав|логист/.test(lower)) return "Доставка и логистика";
    if(/реклам/.test(lower)) return "Реклама";
    return "Прочие расходы";
  }
  if(/ремонт/.test(lower)) return "Ремонт";
  if(/товар/.test(lower)) return "Продажа товаров";
  if(/запчаст/.test(lower)) return "Продажа запчастей";
  return "Дополнительные услуги";
}

async function handleUpdate(update) {
  const message=update.message;
  if (!message?.text) return;
  const chatId=String(message.chat.id), text=message.text.trim();
  if (!hasAccess(chatId)) {await send(chatId,"Доступ запрещён. Telegram-аккаунт не привязан к роли администратора.");return;}
  if(pending.has(chatId)){
    const state=pending.get(chatId);
    if(/^\/cancel/i.test(text)){pending.delete(chatId);await send(chatId,"Отмена.",menu());return;}
    state.description=text;
    db.prepare("INSERT INTO financial_operations(type,category,amount,description,occurred_at,source,external_key,telegram_chat_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(state.type,state.category,state.amount,text,uaDate(new Date()),"telegram",null,chatId,new Date().toISOString());
    pending.delete(chatId);
    await send(chatId,`✅ ${state.type==="expense"?"Расход":"Доход"} сохранён: ${money(state.amount)} · ${escapeHtml(state.category)}\nОписание: ${escapeHtml(text)}`,menu());
    return;
  }
  const amount=parseAmount(text);
  if(amount && /(купил|потратил|расход|оплатил)/i.test(text)){
    const category=detectCategory(text,"expense");pending.set(chatId,{type:"expense",amount,category});
    await send(chatId,`Подтвердить расход ${money(amount)} в категории «${escapeHtml(category)}»?\nОтправьте описание — или /cancel для отмены.`);
    return;
  }
  if(amount && /(получил|доход|принял оплату)/i.test(text)){
    const category=detectCategory(text,"income");pending.set(chatId,{type:"income",amount,category});
    await send(chatId,`Подтвердить доход ${money(amount)} в категории «${escapeHtml(category)}»?\nОтправьте описание — или /cancel для отмены.`);
    return;
  }
  const command=text.split(" ")[0].toLowerCase();
  if(command=== "/start") return send(chatId,"Добро пожаловать в Service Management Bot!\n\nЯ помогу контролировать финансовые показатели сервисного центра, отслеживать доходы, расходы и получать ежемесячные отчёты.",menu());
  if(["/today","/week","/month","/lastmonth","/year"].includes(command)) return send(chatId,report(command.slice(1)));
  if(text.includes("Финансовая статистика")) return send(chatId,report("month"));
  if(text.includes("Доходы")) return send(chatId,report("month").replace(/💸 РАСХОДЫ[\s\S]*?(?=📈)/,""));
  if(text.includes("Расходы")) return send(chatId,report("month").replace(/💰 ДОХОДЫ[\s\S]*?(?=💸)/,""));
  if(text.includes("Статистика ремонтов")) {
    const t=totals(...periodRange("month")); return send(chatId,`<b>🔧 Статистика ремонтов</b>\n• Всего: ${t.repairs}\n• Завершено: ${t.completed}\n• В процессе: ${t.inProgress}\n• Отменено: ${t.cancelled}\n• Оплата за ремонты: ${money(t.repairIncome)}\n• Средняя стоимость: ${money(t.completed?t.repairIncome/t.completed:0)}`);
  }
  if(text.includes("Склад и закупки")) {
    const t=totals(...periodRange("month")); const low=[...db.prepare("SELECT name,quantity,min_stock FROM products").all(),...db.prepare("SELECT name,quantity,min_stock FROM parts").all()].filter(x=>Number(x.quantity)<=Number(x.min_stock||0));
    return send(chatId,`<b>📦 Склад и закупки</b>\n• Закупки за месяц: ${money(t.purchaseExpenses)}\n• Товаров на складе: ${db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM products").get().q}\n• Запчастей на складе: ${db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM parts").get().q}\n\n<b>Минимальные остатки:</b>\n${low.length?low.map(x=>`• ${escapeHtml(x.name)}: ${x.quantity}`).join("\n"):"Критических остатков нет"}`);
  }
  if(text.includes("Отчёт за месяц")) return send(chatId,report("lastmonth"));
  if(command === "/help") return send(chatId,"/today — сегодня\n/week — 7 дней\n/month — текущий месяц\n/lastmonth — прошлый месяц\n/year — текущий год\n/addexpense — добавить расход\n/addincome — добавить доход\n/help — список команд");
  if(command === "/addexpense" || command === "/addincome") {
    return send(chatId,`Напишите сообщение: «${command=== "/addexpense"?"Купил запчасти на 2500 грн":"Получил 1800 грн за ремонт телефона"}». После подтверждения бот попросит описание.`);
  }
  if(command === "/expenses") return send(chatId,report("month").replace(/💰 ДОХОДЫ[\s\S]*?(?=💸)/,""));
  if(command === "/income") return send(chatId,report("month").replace(/💸 РАСХОДЫ[\s\S]*?(?=📈)/,""));
  return send(chatId,"Используйте кнопки меню или /help.");
}

let updateOffset=Number(getSetting("telegram_update_offset","0"));
async function poll() {
  try {
    const updates=await telegram("getUpdates",{offset:updateOffset+1,timeout:30,allowed_updates:["message"]});
    for(const update of updates){updateOffset=update.update_id;db.prepare("INSERT INTO telegram_settings(key,value) VALUES ('telegram_update_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(updateOffset));await handleUpdate(update);}
  } catch (error) {console.error("[Telegram]",error.message);}
}

let monthlySent=false;
async function scheduler() {
  const now=uaNowParts();
  if(now.day===1 && now.hour===9 && now.minute===0 && !monthlySent){
    const period=`${now.year}-${String(now.month-1).padStart(2,"0")}`;
    const recipients=db.prepare("SELECT chat_id FROM telegram_users WHERE active=1 AND role='admin'").all();
    for(const recipient of recipients){
      if(db.prepare("SELECT 1 FROM telegram_sent_reports WHERE period=? AND chat_id=?").get(period,recipient.chat_id)) continue;
      try {await send(recipient.chat_id,report("lastmonth"));db.prepare("INSERT INTO telegram_sent_reports(period,chat_id,sent_at) VALUES (?,?,?)").run(period,recipient.chat_id,new Date().toISOString());}
      catch(error){console.error("[Monthly report]",error.message);}
    }
    monthlySent=true;
  }
  if(now.hour!==9 || now.minute!==0) monthlySent=false;
}

export function startTelegramBot() {
  if(!token){console.warn("[Telegram] TELEGRAM_BOT_TOKEN не задан — бот остановлен.");return;}
  setInterval(poll,1500);
  setInterval(scheduler,30000);
  poll();
  scheduler();
}
