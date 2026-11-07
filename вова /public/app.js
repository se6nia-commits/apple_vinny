const app=document.querySelector("#app"), modal=document.querySelector("#modal"), state={page:"dashboard"};
let settings={};
const $=(s,p=document)=>p.querySelector(s);
const api=(url,method="GET",data)=>fetch(url,{method,headers:{"Content-Type":"application/json"},body:data?JSON.stringify(data):undefined}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||"Ошибка");return d});
const money=n=>new Intl.NumberFormat(settings.currency==="USD"?"en-US":"uk-UA",{style:"currency",currency:settings.currency==="USD"?"USD":"UAH",maximumFractionDigits:0}).format(Number(n||0));
const date=d=>d?new Date(d).toLocaleDateString("ru-UA"): "—";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const toast=t=>{const x=$("#toast");x.textContent=t;x.classList.add("show");setTimeout(()=>x.classList.remove("show"),2200)};
async function loadSettings(){
 try {
  settings=await api("/api/settings");
 } catch {
  settings={centerName:"Apple vinny",currency:"UAH"};
 }
 $("#brandName").textContent=settings.centerName||"Service Center";
 document.querySelector("#currency").value=settings.currency||"UAH";
}
async function init(){
 await loadSettings();
 bind();
 try { await render(); }
 catch {
  app.innerHTML=`${title("Сервер API недоступен","Интерфейс открыт, но данные не загружены.",`<button class="btn secondary" onclick="location.reload()">Повторить</button>`)}<div class="card"><h3>Требуется Node-сервер</h3><p>Netlify показывает только frontend. Для работы данных задеплойте проект как Node-приложение на Render/Railway и включите постоянный диск для папки <b>data</b>.</p></div>`;
 }
}
function bind(){
 document.querySelector("#nav").addEventListener("click",e=>{const b=e.target.closest("button[data-page]");if(!b)return;document.querySelectorAll("#nav button").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.page=b.dataset.page;render();document.querySelector(".sidebar").classList.remove("open")});
 $(".menu-btn").addEventListener("click",()=>$(".sidebar").classList.toggle("open"));
 $("#currency").addEventListener("change",async e=>{await api("/api/settings","PUT",{currency:e.target.value});settings.currency=e.target.value;render();toast("Валюта изменена")});
 $("#globalSearch").addEventListener("input",async e=>{const q=e.target.value.trim(),box=$("#searchResults");if(q.length<2){box.style.display="none";return}const r=await api("/api/global-search?q="+encodeURIComponent(q));box.innerHTML=r.length?r.map(x=>`<div class="search-result" data-page="${x.type==="Ремонт"?"repairs":x.type==="Товар"?"products":x.type==="Запчасть"?"parts":"clients"}">${esc(x.label)} · ${x.type}</div>`).join(""):'<div class="search-result">Ничего не найдено</div>';box.style.display="block"});
 $("#searchResults").addEventListener("click",e=>{const r=e.target.closest(".search-result[data-page]");if(!r)return;document.querySelector(`[data-page="${r.dataset.page}"]`)?.click();$("#searchResults").style.display="none"});
 document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal()});
}
async function render(){
 const renderers={dashboard:dashboard,repairs:crudPage.bind(null,"repairs"),products:crudPage.bind(null,"products"),parts:crudPage.bind(null,"parts"),clients:crudPage.bind(null,"clients"),stock:stock,operations:operations,finance:finance,settings:settingsPage};
 await renderers[state.page]();
}
function title(t,sub,action){return `<div class="page-title"><div><h1>${t}</h1><p>${sub||""}</p></div>${action||""}</div>`}
async function dashboard(){
 const d=await api("/api/dashboard");
 app.innerHTML=title("Главная панель","Обзор работы сервисного центра",`<button class="btn" onclick="openForm('repairs')">+ Новый ремонт</button>`);
 app.innerHTML+=`<div class="cards">
 ${metric("Всего ремонтов",d.counts.repairs,"blue")} ${metric("Новые",d.counts.new,"blue")} ${metric("В процессе",d.counts.inProgress,"orange")} ${metric("Завершённые",d.counts.done,"green")}
 ${metric("Товаров",d.counts.products,"blue")} ${metric("Запчастей",d.counts.parts,"blue")} ${metric("Критические остатки",d.counts.low,"red")} ${metric("Стоимость склада",money(d.counts.inventory),"green")}
 </div><div class="grid2"><div class="card"><h3>Последние ремонты</h3>${table(["Номер","Клиент","Устройство","Статус"],d.latestRepairs.map(r=>[r.number,r.client_name,r.device,status(r.status)]))}</div><div class="card"><h3>Складские операции</h3>${d.latestOps.length?table(["Позиция","Операция","Кол-во"],d.latestOps.map(x=>[x.item_name,x.kind==="receipt"?"Поступление":"Списание",x.quantity])):'<div class="empty">Операций пока нет</div>'}</div></div>
 <div class="grid3" style="margin-top:14px"><div class="card"><h3>Заканчиваются</h3>${d.lowItems.length?d.lowItems.map(x=>`<div class="stat-line"><span>${esc(x.name)}</span><b class="accent-red">${x.quantity}</b></div>`).join(""):'<div class="empty">Критических остатков нет</div>'}</div><div class="card"><h3>Быстрые действия</h3><button class="btn" onclick="openForm('repairs')">Добавить ремонт</button><br><br><button class="btn secondary" onclick="openForm('products')">Добавить товар</button><br><br><button class="btn secondary" onclick="openForm('parts')">Добавить запчасть</button></div><div class="card"><h3>Ремонты за неделю</h3><div class="chart">${[32,48,38,65,52,78,44].map((v,i)=>`<div class="bar-wrap"><div class="bar" style="height:${v}%"></div><span>${["Пн","Вт","Ср","Чт","Пт","Сб","Вс"][i]}</span></div>`).join("")}</div></div></div>`;
}
function metric(l,v,c){return `<div class="card"><div class="metric-label">${l}</div><div class="metric accent-${c}">${v}</div></div>`}
function status(s){const cls=/Готов|Выдан/.test(s)?"good":/Ожидает|Отмен/.test(s)?"warning":"";return `<span class="status ${cls}">${esc(s)}</span>`}
function table(heads,rows){return `<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${heads.length}" class="empty">Записей нет</td></tr>`}</tbody></table></div>`}
const configs={
 repairs:{title:"Ремонты",sub:"Приём, ремонт и выдача устройств",endpoint:"repairs",cols:["number","client_name","device","status"],heads:["Номер","Клиент","Устройство","Статус",""],fields:[
  ["number","Номер заказа"],["client_name","Имя клиента"],["phone","Телефон"],["device","Устройство"],["fault","Неисправность","textarea"],["repair_cost","Стоимость ремонта","number"],["parts_cost","Стоимость запчастей","number"],["received","Начало гарантии","date"],["due","Конец гарантии (не более месяца)","date"],["status","Статус ремонта","select","Новый|Принят в работу|Диагностика|Ожидает запчасти|В процессе ремонта|Готов|Выдан клиенту|Отменён"]]},
 products:{title:"Товары в наличии",sub:"Каталог товаров для продажи",endpoint:"products",cols:["name","category","quantity","sale_price"],heads:["Название","Категория","Количество","Цена продажи",""],fields:[["name","Название"],["category","Категория"],["quantity","Количество","number"],["purchase_price","Закупочная цена","number"],["sale_price","Цена продажи","number"],["repair_price","Цена ремонта","number"],["supplier","Поставщик"],["description","Описание","textarea"]]},
 parts:{title:"Запчасти в наличии",sub:"Компоненты и расходники для ремонта",endpoint:"parts",cols:["name","category","quantity"],heads:["Название","Категория","Количество",""],fields:[["name","Название"],["category","Категория"],["quantity","Количество","number"],["purchase_price","Закупочная цена","number"],["min_stock","Минимальный остаток","number"],["comment","Комментарий","textarea"]]},
 clients:{title:"Клиенты",sub:"База клиентов и история обращений",endpoint:"clients",cols:["name","phone","email","first_date"],heads:["Имя","Телефон","Email","Первое обращение",""],fields:[["name","Имя"],["phone","Телефон"],["email","Email","email"],["first_date","Дата первого обращения","date"],["comments","Комментарии","textarea"]]}
};
async function crudPage(type){
 const c=configs[type], rows=await api("/api/"+c.endpoint);
 app.innerHTML=title(c.title,c.sub,`<button class="btn" onclick="openForm('${type}')">+ Добавить</button>`);
 app.innerHTML+=`<div class="card"><div class="toolbar"><input id="filter" placeholder="Поиск..."><select id="sort"><option value="">Без сортировки</option><option value="name">По названию</option><option value="quantity">По количеству</option><option value="sale_price">По цене</option></select></div><div id="table"></div></div>`;
 const draw=()=>{const q=$("#filter").value.toLower?$("#filter").value.toLower().trim(): "";let list=rows.filter(r=>Object.values(r).join(" ").toLowerCase().includes(q));const sort=$("#sort").value;if(sort)list=[...list].sort((a,b)=>String(a[sort]||"").localeCompare(String(b[sort]||"")));$("#table").innerHTML=table(c.heads,list.map(r=>[...c.cols.map(k=>k==="sale_price"?money(r[k]):k==="quantity"&&Number(r[k])<=Number(r.min_stock||0)?`<b class="accent-red">${r[k]}</b>`:esc(r[k])),`<button class="btn small secondary" onclick="openForm('${type}',${r.id})">Изменить</button> <button class="btn small danger" onclick="deleteItem('${type}',${r.id})">Удалить</button>`]))}; $("#filter").oninput=draw;$("#sort").onchange=draw;draw();
}
async function stock(){
 const [items,ops]=await Promise.all([api("/api/stock"),api("/api/stock-operations")]);
 app.innerHTML=title("Склад","Остатки и складские операции",`<button class="btn" onclick="stockModal()">+ Складская операция</button>`);
 app.innerHTML+=`<div class="grid2"><div class="card"><h3>Текущие остатки</h3>${table(["Позиция","Тип","Количество"],items.map(x=>[esc(x.name),x.itemKind==="product"?"Товар":"Запчасть",Number(x.quantity)<=Number(x.min_stock||0)?`<b class="accent-red">${x.quantity}</b>`:x.quantity]))}</div><div class="card"><h3>Журнал операций</h3>${table(["Дата","Позиция","Операция","Кол-во"],ops.slice(0,20).map(x=>[date(x.date),esc(x.item_name),x.kind==="receipt"?"Поступление":"Списание",x.quantity]))}</div></div>`;
}
function stockModal(){stockModalView()}
async function stockModalView(){
 const items=await api("/api/stock");openModal("Складская операция",`<form class="form-grid" id="stockForm">
 <label class="full">Позиция<select name="item" required>${items.map(x=>`<option value="${x.itemKind}:${x.id}">${esc(x.name)} (${x.quantity})</option>`).join("")}</select></label>
 <label>Операция<select name="kind"><option value="receipt">Поступление</option><option value="writeoff">Списание</option></select></label>
 <label>Количество<input name="quantity" type="number" min="0.01" step="0.01" required></label><label>Закупочная стоимость<input name="cost" type="number" min="0"></label><label>Дата<input name="date" type="date" value="${new Date().toISOString().slice(0,10)}" required></label><label>Поставщик<input name="supplier"></label><label>Причина списания<input name="reason"></label><label class="full">Комментарий<textarea name="comment"></textarea></label><div class="form-actions full"><button type="button" class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn">Провести</button></div></form>`);
 $("#stockForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),d=Object.fromEntries(f);[d.itemKind,d.itemId]=d.item.split(":");d.itemId=Number(d.itemId);try{await api("/api/stock-operations","POST",d);closeModal();render();toast("Складская операция проведена")}catch(err){toast(err.message)}};
}
async function operations(){
 const ops=await api("/api/operations");app.innerHTML=title("История операций","Журнал действий пользователей");app.innerHTML+=`<div class="card">${table(["Дата и время","Тип","Описание","Пользователь"],ops.map(x=>[new Date(x.created_at).toLocaleString("ru-UA"),esc(x.type),esc(x.description),esc(x.actor)]))}</div>`;
}
async function finance(){
 const repairs=await api("/api/repairs"),products=await api("/api/products"),parts=await api("/api/parts");const revenue=repairs.reduce((s,r)=>s+(Number(r.repair_cost)||0),0),done=repairs.filter(r=>["Готов","Выдан клиенту"].includes(r.status)).length,stockValue=products.reduce((s,x)=>s+x.quantity*x.purchase_price,0)+parts.reduce((s,x)=>s+x.quantity*x.purchase_price,0),profit=revenue-repairs.reduce((s,r)=>s+(Number(r.parts_cost)||0),0);
 app.innerHTML=title("Финансы и статистика","Финансовые показатели и аналитика");app.innerHTML+=`<div class="cards">${metric("Выручка ремонтов",money(revenue),"green")}${metric("Расходы на запчасти",money(repairs.reduce((s,r)=>s+(Number(r.parts_cost)||0),0)),"orange")}${metric("Прибыль",money(profit),"green")}${metric("Стоимость остатков",money(stockValue),"blue")}</div><div class="grid2"><div class="card"><h3>Количество ремонтов</h3><div class="chart">${[5,8,7,12,9,14].map((v,i)=>`<div class="bar-wrap"><div class="bar" style="height:${v*5}%"></div><span>${i+1}</span></div>`).join("")}</div></div><div class="card"><h3>Основные показатели</h3><div class="stat-list"><div class="stat-line"><span>Выполнено ремонтов</span><b>${done}</b></div><div class="stat-line"><span>Активные ремонты</span><b>${repairs.length-done}</b></div><div class="stat-line"><span>Средний чек ремонта</span><b>${money(revenue/(repairs.length||1))}</b></div></div></div></div>`;
}
async function settingsPage(){
 settings=await api("/api/settings");app.innerHTML=title("Настройки","Параметры системы");
 app.innerHTML+=`<div class="card" style="max-width:720px"><form class="form-grid" id="settingsForm"><label>Название сервисного центра<input name="centerName" value="${esc(settings.centerName||"")}"></label><label>Валюта<select name="currency"><option value="UAH" ${settings.currency==="UAH"?"selected":""}>Украинская гривна</option><option value="USD" ${settings.currency==="USD"?"selected":""}>Доллар США</option><option value="EUR" ${settings.currency==="EUR"?"selected":""}>Евро</option></select></label><label class="full">Резервное копирование<div><button type="button" class="btn secondary" onclick="backup()">Скачать резервную копию</button></div></label><div class="form-actions full"><button class="btn">Сохранить</button></div></form></div>`;
 $("#settingsForm").onsubmit=async e=>{e.preventDefault();await api("/api/settings","PUT",Object.fromEntries(new FormData(e.target)));await loadSettings();render();toast("Настройки сохранены")};
}
async function backup(){location.href="/api/backup"}
function openModal(titleHtml,content){modal.innerHTML=`<div class="modal-box"><div class="modal-head"><h2>${titleHtml}</h2><button class="close" aria-label="Закрыть" onclick="closeModal()">×</button></div>${content}</div>`;modal.classList.add("open");modal.setAttribute("aria-hidden","false")}
function closeModal(){modal.classList.remove("open");modal.setAttribute("aria-hidden","true")}
window.openForm=async function(type,id=null){const c=configs[type];let data={};if(id)data=await api(`/api/${c.endpoint}/${id}`)||{};const today=new Date();const addMonth=value=>{const d=value?new Date(value+"T12:00:00"):new Date(today);d.setMonth(d.getMonth()+1);return d.toISOString().slice(0,10)};
openModal(id?"Редактирование записи":"Новая запись",`<form class="form-grid" id="crudForm">${c.fields.map(f=>{let value=data[f[0]]||"";if(f[0]==="received" && type==="repairs" && !value)value=today.toISOString().slice(0,10);if(f[0]==="due" && type==="repairs" && !value)value=addMonth(value||today.toISOString().slice(0,10));if(typeof value==="string" && /^\d{4}-\d{2}-\d{2}T/.test(value))value=value.slice(0,10);return `<label class="${f[2]==="textarea"?"full":""}">${f[1]}${f[2]==="textarea"?`<textarea name="${f[0]}">${esc(value)}</textarea>`:f[2]==="select"?`<select name="${f[0]}">${f[3].split("|").map(x=>`<option ${data[f[0]]===x?"selected":""}>${x}</option>`).join("")}</select>`:`<input name="${f[0]}" type="${f[2]||"text"}" value="${esc(value)}" required>`}</label>`}).join("")}<div class="form-actions full"><button type="button" class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn">Сохранить</button></div></form>`);
if(type==="repairs"){
 const received=$('[name="received"]'),due=$('[name="due"]');
 const syncWarranty=()=>{if(!received.value)return;due.min=received.value;due.max=addMonth(received.value);if(!due.value || due.value<received.value || due.value>due.max)due.value=due.max};
 received.addEventListener("change",syncWarranty);syncWarranty();
}
$("#crudForm").onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));["quantity","min_stock","purchase_price","sale_price","repair_price","repair_cost","parts_cost"].forEach(k=>{if(data[k]!==undefined)data[k]=Number(data[k])});try{await api(`/api/${c.endpoint}${id?"/"+id:""}`,id?"PUT":"POST",data);closeModal();render();toast("Запись сохранена")}catch(err){toast(err.message)}}
}
window.deleteItem=async function(type,id){if(!confirm("Удалить запись? Это действие нельзя отменить."))return;await api(`/api/${configs[type].endpoint}/${id}`,"DELETE");render();toast("Запись удалена")}
window.stockModal=stockModalView;window.closeModal=closeModal;window.backup=backup;
init();
