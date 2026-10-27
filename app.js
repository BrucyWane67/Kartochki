/* Карточки — полностью локальное приложение, без аналитики и сервера */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const DB_NAME = 'kartochki-local-v1', STORE = 'data', DB_KEY = 'library';
const MAX_IMPORT = 10000, MAX_FILE = 10 * 1024 * 1024;
const titles = {study:'Учить слова',words:'Мои слова',decks:'Наборы',stats:'Статистика',settings:'Настройки'};
let db, state, activeView='study', session=null, editDeckId=null, editCardId=null, splitDeckId=null, listDeckId=null, installPrompt=null;
let saveQueue=Promise.resolve(), toastTimer=null, summaryEl;
const now = () => Date.now();
const uid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${now().toString(36)}${Math.random().toString(36).slice(2,12)}`);
const blankReview = () => ({seen:0,known:0,wrong:0,streak:0,due:0,interval:0});
function newCard(deckId,front,back){return {id:uid(),deckId,front,back,starred:false,partId:null,createdAt:now(),review:{forward:blankReview(),backward:blankReview()}};}
const getDeck = id => state.decks.find(d=>d.id===id) || null;
const activeDeck = () => getDeck(state.prefs.deckId) || state.decks[0] || null;
const cardsInDeck = id => state.cards.filter(c=>c.deckId===id);
function startData(){
  const id=uid();const pairs=[['Apple','яблоко'],['House','дом'],['Beautiful','красивый'],['Remember','помнить'],['Understand','понимать'],['Morning','утро']];
  return {version:2,decks:[{id,name:'Английский · пример',frontLang:'English',backLang:'Русский',parts:[],createdAt:now()}],cards:pairs.map(p=>newCard(id,...p)),reviews:[],prefs:{deckId:id,partId:'all',direction:'forward',mode:'flip',scope:'all',shuffle:true}};
}
function validState(data){
  if(!data || !Array.isArray(data.decks) || !Array.isArray(data.cards) || !Array.isArray(data.reviews)) throw new Error('Неверный формат резервной копии.');
  if(data.decks.length>2000 || data.cards.length>100000 || data.reviews.length>1000000) throw new Error('Слишком большой файл данных.');
  const ids=new Set();
  const decks=data.decks.map(d=>{
    if(typeof d.id!=='string'||ids.has(d.id))throw new Error('Повторяющиеся или некорректные наборы.');
    ids.add(d.id);
    const partIds=new Set();const parts=Array.isArray(d.parts)?d.parts.slice(0,100).filter(part=>part && typeof part.id==='string'&&!partIds.has(part.id)).map(part=>{partIds.add(part.id);return {id:part.id,name:String(part.name||'Часть').slice(0,70)};}):[];
    return {id:d.id,name:String(d.name||'Без названия').slice(0,100),frontLang:String(d.frontLang||'Первый язык').slice(0,50),backLang:String(d.backLang||'Второй язык').slice(0,50),parts,createdAt:Number(d.createdAt)||now()};
  });
  const partIdsByDeck=new Map(decks.map(d=>[d.id,new Set(d.parts.map(part=>part.id))]));
  const cardIds=new Set();
  const cards=data.cards.map(c=>{
    if(!ids.has(c.deckId)||typeof c.id!=='string'||cardIds.has(c.id))throw new Error('Некорректные карточки в файле.');cardIds.add(c.id);
    const review={};for(const dir of ['forward','backward']){const r=c.review&&c.review[dir]||{};review[dir]={seen:Math.max(0,Number(r.seen)||0),known:Math.max(0,Number(r.known)||0),wrong:Math.max(0,Number(r.wrong)||0),streak:Math.max(0,Number(r.streak)||0),due:Math.max(0,Number(r.due)||0),interval:Math.max(0,Number(r.interval)||0)};}
    return {id:c.id,deckId:c.deckId,front:String(c.front||'').slice(0,1000),back:String(c.back||'').slice(0,1000),starred:c.starred===true,partId:partIdsByDeck.get(c.deckId).has(c.partId)?c.partId:null,createdAt:Number(c.createdAt)||now(),review};
  });
  const raw=data.prefs||{};
  const deckId=ids.has(raw.deckId)?raw.deckId:(decks[0]?.id||null);
  const prefs={deckId,partId:partIdsByDeck.get(deckId)?.has(raw.partId)?raw.partId:'all',direction:['forward','backward','mixed'].includes(raw.direction)?raw.direction:'forward',mode:['flip','type'].includes(raw.mode)?raw.mode:'flip',scope:['all','due','starred','starred-due'].includes(raw.scope)?raw.scope:'all',shuffle:raw.shuffle!==false};
  const reviews=data.reviews.filter(r=>r&&typeof r.at==='number'&&typeof r.correct==='boolean').map(r=>({at:r.at,correct:r.correct,deckId:String(r.deckId||''),direction:String(r.direction||'forward')}));
  return {version:2,decks,cards,reviews,prefs};
}
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE);};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('Ошибка IndexedDB'));req.onblocked=()=>reject(new Error('База данных заблокирована другой вкладкой.'));});}
function dbGet(){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly');const req=tx.objectStore(STORE).get(DB_KEY);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function dbPut(data){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(data,DB_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Не удалось сохранить данные'));});}
function save(){const snapshot=JSON.parse(JSON.stringify(state));$('saveStatus').textContent='Сохраняем…';saveQueue=saveQueue.catch(()=>{}).then(()=>dbPut(snapshot)).then(()=>{$('saveStatus').textContent='Сохранено на устройстве';}).catch(e=>{console.error(e);$('saveStatus').textContent='Ошибка сохранения';toast('Не удалось сохранить данные: проверь доступное место');});return saveQueue;}
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('is-visible'),3600);}
function setView(view){if(!titles[view])return;activeView=view;$$('[data-section]').forEach(s=>s.hidden=s.dataset.section!==view);$$('[data-view]').forEach(b=>b.classList.toggle('is-active',b.dataset.view===view));$('pageTitle').textContent=titles[view];window.scrollTo({top:0,behavior:'instant'});render();}
function selectOptions(el,includeAll=false){const prev=el.value;el.replaceChildren();if(includeAll){const o=new Option('Все наборы','all');el.add(o);}for(const d of state.decks){const option=new Option(d.name,d.id);el.add(option);}const preferred=el.id==='wordsDeck' && prev==='all'?'all':state.decks.some(d=>d.id===prev)?prev:activeDeck()?.id||(includeAll?'all':'');if(preferred)el.value=preferred;}
function refreshDeckChoices(){selectOptions($('studyDeck'));selectOptions($('importDeck'));selectOptions($('wordsDeck'),true);if(activeDeck()){$('studyDeck').value=activeDeck().id;$('importDeck').value=activeDeck().id;}}
function render(){refreshDeckChoices();if(activeView==='study')renderStudy();if(activeView==='words')renderWords();if(activeView==='decks')renderDecks();if(activeView==='stats')renderStats();}
function dirLabel(deck,dir){return dir==='forward'?`${deck.frontLang} → ${deck.backLang}`:`${deck.backLang} → ${deck.frontLang}`;}
function due(card,dir){const r=card.review[dir];return !r.seen||r.due<=now();}
function cardsForPart(deckId,partId='all'){return cardsInDeck(deckId).filter(c=>partId==='all'||(partId==='unassigned'?!c.partId:c.partId===partId));}
function hasUnassigned(deckId){return cardsInDeck(deckId).some(c=>!c.partId);}
function fillPartOptions(select,deck,value='all'){
  select.replaceChildren(new Option('Весь набор','all'));
  if(deck?.parts?.length){for(const part of deck.parts)select.add(new Option(`${part.name} · ${cardsForPart(deck.id,part.id).length}`,part.id));if(hasUnassigned(deck.id))select.add(new Option(`Без части · ${cardsForPart(deck.id,'unassigned').length}`,'unassigned'));}
  select.value=Array.from(select.options).some(o=>o.value===value)?value:'all';
}
function eligible(deckId,direction,scope,partId='all'){
  const entries=[];for(const c of cardsForPart(deckId,partId)){
    if(scope.startsWith('starred')&&!c.starred)continue;
    for(const dir of (direction==='mixed'?['forward','backward']:[direction])){
      if(!['due','starred-due'].includes(scope)||due(c,dir))entries.push({cardId:c.id,dir,attempts:0});
    }
  }return entries;
}
function learnedCard(card){return Boolean(card.review.forward.seen||card.review.backward.seen);}
function renderPartOverview(deck){const el=$('partOverview');el.replaceChildren();el.hidden=!deck?.parts?.length;if(el.hidden)return;
  const label=document.createElement('div');label.className='part-overview-title';label.textContent='Части набора · изучай отдельно или повторяй весь набор';el.append(label);
  const row=document.createElement('div');row.className='part-tiles';
  for(const item of [{id:'all',name:'Весь набор'},...deck.parts,...(hasUnassigned(deck.id)?[{id:'unassigned',name:'Без части'}]:[])]){
    const cards=cardsForPart(deck.id,item.id);const seen=cards.filter(learnedCard).length;
    const button=document.createElement('button');button.type='button';button.className='part-tile'+(state.prefs.partId===item.id?' selected':'');
    const title=document.createElement('strong');title.textContent=item.name;const desc=document.createElement('small');desc.textContent=`${cards.length} слов · ${seen} повторяли`;
    button.append(title,desc);button.addEventListener('click',()=>{state.prefs.partId=item.id;session=null;save();renderStudy();});row.append(button);
  }el.append(row);
}
function renderStudy(){
  $('studyDirection').value=state.prefs.direction;$('studyMode').value=state.prefs.mode;$('studyScope').value=state.prefs.scope;$('studyShuffle').checked=state.prefs.shuffle;
  const deck=activeDeck();fillPartOptions($('studyPart'),deck,state.prefs.partId);state.prefs.partId=$('studyPart').value;
  if(deck){$('studyDirection').options[0].textContent=`${deck.frontLang} → ${deck.backLang}`;$('studyDirection').options[1].textContent=`${deck.backLang} → ${deck.frontLang}`;}
  renderPartOverview(deck);
  const count=deck?eligible(deck.id,state.prefs.direction,state.prefs.scope,state.prefs.partId).length:0;
  $('studyCount').textContent=`${count} ${plural(count,'карточка','карточки','карточек')} для тренировки`;
  $('startStudy').disabled=count===0;$('openFullList').disabled=!deck;$('studyWelcome').hidden=state.cards.length!==6||state.decks[0]?.name!=='Английский · пример';
  $('studyEmpty').hidden=Boolean(session)||count>0;
  const emptyTitle=$('studyEmpty').querySelector('h3'),emptyText=$('studyEmpty').querySelector('p');
  if(deck&&cardsForPart(deck.id,state.prefs.partId).length&&['due','starred-due'].includes(state.prefs.scope)){emptyTitle.textContent='На сегодня всё повторено';emptyText.textContent='Попробуй выбрать «Все слова» или «Только со звёздочкой».';}
  else if(deck&&['starred','starred-due'].includes(state.prefs.scope)){emptyTitle.textContent='Нет отмеченных слов';emptyText.textContent='Нажми ☆ на карточке или в списке слов, чтобы добавить звёздочку.';}
  else{emptyTitle.textContent='Пока нет слов для тренировки';emptyText.textContent='Добавь список слов или переключи набор и часть.';}
  $('session').hidden=!session;
  if(session)showSessionCard();
}
function plural(n,a,b,c){n=Math.abs(n)%100;const v=n%10;return n>10&&n<20?c:v===1?a:v>=2&&v<=4?b:c;}
function startSession(){
  const deck=activeDeck();if(!deck){toast('Сначала создай набор');return;}
  let queue=eligible(deck.id,state.prefs.direction,state.prefs.scope,state.prefs.partId);
  if(!queue.length){toast('Нет карточек для выбранного режима');return;}
  if(state.prefs.shuffle){for(let i=queue.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[queue[i],queue[j]]=[queue[j],queue[i]];}}
  session={queue,current:null,history:[],historyIndex:null,revealed:false,typedDraft:'',done:0,correct:0,wrong:0,original:queue.length,mode:state.prefs.mode,pendingCorrect:null,deckId:deck.id,partId:state.prefs.partId};
  if(summaryEl)summaryEl.hidden=true;nextSessionCard();
}
function nextSessionCard(){if(!session)return;if(!session.queue.length){finishSession();return;}
  session.current=session.queue.shift();session.pendingCorrect=null;session.revealed=false;session.typedDraft='';session.historyIndex=null;renderStudy();
}
function sessionDisplayedItem(){return !session?null:session.historyIndex===null?session.current:session.history[session.historyIndex]||null;}
function showSessionCard(){
  if(!session?.current)return;const current=sessionDisplayedItem();const card=state.cards.find(c=>c.id===current?.cardId),deck=getDeck(session.deckId);
  if(!card||!deck){if(session.historyIndex!==null){session.historyIndex=null;showSessionCard();}else nextSessionCard();return;}
  const preview=session.historyIndex!==null;
  const front=current.dir==='forward'?card.front:card.back,back=current.dir==='forward'?card.back:card.front;
  $('cardWord').textContent=front;$('answerWord').textContent=back;$('cardDirection').textContent=dirLabel(deck,current.dir);
  $('cardStar').textContent=card.starred?'★':'☆';$('cardStar').classList.toggle('is-starred',card.starred);$('cardStar').setAttribute('aria-pressed',String(card.starred));$('cardStar').setAttribute('aria-label',card.starred?'Снять звёздочку':'Отметить звёздочкой');
  $('sessionLabel').textContent=`Пройдено: ${session.done} · Осталось: ${session.queue.length+1}`;
  $('sessionScore').textContent=`✓ ${session.correct}  ·  ✕ ${session.wrong}`;
  $('sessionProgress').style.width=`${Math.round(100*session.done/(session.done+session.queue.length+1))}%`;
  $('previousCard').disabled=!session.history.length||(preview&&session.historyIndex===0);
  $('forwardCard').hidden=!preview;
  $('historyHint').textContent=preview?`Предыдущая: ${session.historyIndex+1} из ${session.history.length}. Только просмотр.`:'Можно вернуться к предыдущему слову';
  $('cardAnswer').hidden=!(preview||session.revealed||session.pendingCorrect!==null);
  $('frontCaption').textContent=$('cardAnswer').hidden?'ПЕРЕВЕДИ СЛОВО':'ВОПРОС';
  $('flipControls').hidden=preview||session.mode!=='flip';$('typeControls').hidden=preview||session.mode!=='type';
  $('showAnswer').hidden=Boolean(session.revealed);$('gradeControls').hidden=!session.revealed;
  $('typedAnswer').value=session.typedDraft;$('typedAnswer').disabled=session.pendingCorrect!==null;
  $('checkTyped').hidden=session.pendingCorrect!==null;$('typeResult').hidden=session.pendingCorrect===null;
  $('typeNextControls').hidden=session.pendingCorrect===null;$('overrideCorrect').hidden=session.pendingCorrect===true;
  if(session.pendingCorrect!==null){$('typeResult').classList.toggle('is-bad',!session.pendingCorrect);$('typeResult').textContent=session.pendingCorrect?'✓ Правильно!':'✕ Пока не совпало. Посмотри правильный ответ ниже.';}
}
function revealAnswer(){if(!session||session.historyIndex!==null)return;session.revealed=true;showSessionCard();}
function historyPrev(){if(!session?.history.length)return;
  if(session.historyIndex===null){session.typedDraft=$('typedAnswer').value;session.historyIndex=session.history.length-1;}
  else session.historyIndex=Math.max(0,session.historyIndex-1);
  showSessionCard();
}
function historyNext(){if(!session||session.historyIndex===null)return;
  session.historyIndex=session.historyIndex+1>=session.history.length?null:session.historyIndex+1;showSessionCard();
}
function normalized(s){return String(s||'').normalize('NFKC').toLocaleLowerCase().replace(/[\u0591-\u05c7]/g,'').replace(/[\u0300-\u036f]/g,'').replace(/[.,!?«»“”"'`]/g,'').replace(/\s+/g,' ').trim();}
function answerMatches(input,target){const entered=normalized(input);if(!entered)return false;if(entered===normalized(target))return true;return String(target).split(/\s+[\/;]\s+|\s*;\s*|\s+\/\s+/).some(s=>normalized(s)===entered);}
function verifyTyped(){
  if(!session||session.mode!=='type'||session.historyIndex!==null)return;
  if(session.pendingCorrect!==null){gradeCurrent(session.pendingCorrect);return;}
  const item=session.current,card=state.cards.find(c=>c.id===item.cardId);if(!card)return;
  const actual=item.dir==='forward'?card.back:card.front;
  session.typedDraft=$('typedAnswer').value;
  if(!session.typedDraft.trim()){toast('Введите перевод');return;}
  session.pendingCorrect=answerMatches(session.typedDraft,actual);showSessionCard();
}
function gradeCurrent(correct){
  if(!session?.current||session.historyIndex!==null)return;
  const item=session.current,card=state.cards.find(c=>c.id===item.cardId);
  if(!card){nextSessionCard();return;}
  const r=card.review[item.dir];r.seen++;
  if(correct){r.known++;r.streak++;r.interval=r.streak===1?1:r.streak===2?3:Math.min(180,Math.round((r.interval||3)*2.1));r.due=now()+r.interval*86400000;session.correct++;}
  else{r.wrong++;r.streak=0;r.interval=0;r.due=now()+60000;session.wrong++;if(item.attempts<1){const revisit={...item,attempts:item.attempts+1};session.queue.splice(Math.min(2,session.queue.length),0,revisit);}}
  state.reviews.push({at:now(),deckId:card.deckId,direction:item.dir,correct});
  session.history.push({...item});session.done++;save();nextSessionCard();
}
function finishSession(){
  const {correct,wrong,done,deckId,partId}=session;session=null;$('session').hidden=true;renderStudy();summaryEl.hidden=false;
  summaryEl.querySelector('h3').textContent='Тренировка завершена!';
  summaryEl.querySelector('p').textContent=`Ответов: ${done}. Верных: ${correct}, ошибок: ${wrong}. Прогресс сохранён.`;
  summaryEl.querySelector('button').onclick=startSession;
  const old=summaryEl.querySelector('.next-part-btn');if(old)old.remove();
  const deck=getDeck(deckId);const pos=deck?.parts?.findIndex(p=>p.id===partId)??-1;
  if(pos>=0&&pos<deck.parts.length-1){
    const button=document.createElement('button');button.type='button';button.className='btn btn-secondary next-part-btn';
    button.textContent=`Перейти к «${deck.parts[pos+1].name}» →`;
    button.addEventListener('click',()=>{state.prefs.deckId=deckId;state.prefs.partId=deck.parts[pos+1].id;state.prefs.scope='all';save();startSession();});summaryEl.append(button);
  }else if(pos===deck?.parts?.length-1){const button=document.createElement('button');button.type='button';button.className='btn btn-secondary next-part-btn';button.textContent='Повторить весь набор →';button.addEventListener('click',()=>{state.prefs.deckId=deckId;state.prefs.partId='all';state.prefs.scope='all';save();startSession();});summaryEl.append(button);}
}
function toggleStar(id){const card=state.cards.find(c=>c.id===id);if(!card)return;card.starred=!card.starred;save();
  if(activeView==='study')renderStudy();if(activeView==='words')renderWords();if(activeView==='decks')renderDecks();
  if($('listDialog').open)renderFullList();toast(card.starred?'★ Слово отмечено':'Звёздочка снята');
}
function starButton(card){const b=document.createElement('button');b.type='button';b.className='star-btn word-star'+(card.starred?' is-starred':'');b.textContent=card.starred?'★':'☆';b.title=card.starred?'Убрать звёздочку':'Отметить звёздочкой';b.setAttribute('aria-label',b.title);b.setAttribute('aria-pressed',String(card.starred));b.addEventListener('click',()=>toggleStar(card.id));return b;}
function renderWords(){
  const id=$('wordsDeck').value,filter=$('wordFilter').value,query=normalized($('searchWords').value);
  const list=state.cards.filter(c=>(id==='all'||c.deckId===id)&&(!query||normalized(c.front).includes(query)||normalized(c.back).includes(query))&&(filter==='all'||(filter==='new'&&!learnedCard(c))||(filter==='due'&&(due(c,'forward')||due(c,'backward')))||(filter==='learned'&&learnedCard(c))||(filter==='starred'&&c.starred)));
  const tbody=$('wordsRows');tbody.replaceChildren();for(const c of list.slice(0,1500)){
    const tr=document.createElement('tr');const star=document.createElement('td');star.className='star-cell';star.append(starButton(c));tr.append(star);
    for(const val of [c.front,c.back]){const td=document.createElement('td');td.textContent=val;td.dir='auto';tr.append(td);}
    const stat=document.createElement('td');const seen=c.review.forward.seen+c.review.backward.seen;stat.textContent=seen?`${seen} ${plural(seen,'повторение','повторения','повторений')}`:'Новое';tr.append(stat);
    const action=document.createElement('td');action.className='row-actions';const edit=document.createElement('button');edit.type='button';edit.className='tiny-btn';edit.title='Редактировать';edit.textContent='✎';edit.addEventListener('click',()=>openEditWord(c.id));const del=document.createElement('button');del.type='button';del.className='tiny-btn';del.textContent='×';del.title='Удалить слово';del.addEventListener('click',()=>deleteWord(c.id));action.append(edit,del);tr.append(action);tbody.append(tr);
  }
  $('wordsEmpty').hidden=list.length>0;$('wordsTotal').textContent=`Показано: ${Math.min(list.length,1500)} из ${list.length} · Всего в словаре: ${state.cards.length}`;
}
function openFullList(deckId){const deck=getDeck(deckId||activeDeck()?.id);if(!deck){toast('Создай набор');return;}
  listDeckId=deck.id;$('fullListTitle').textContent=deck.name;$('fullListSearch').value='';$('fullListFilter').value='all';
  fillPartOptions($('fullListPart'),deck,deck.id===state.prefs.deckId?state.prefs.partId:'all');renderFullList();openDialog('listDialog');
}
function renderFullList(){const deck=getDeck(listDeckId);if(!deck)return;
  const part=$('fullListPart').value,filter=$('fullListFilter').value,query=normalized($('fullListSearch').value);
  const list=cardsForPart(deck.id,part).filter(c=>(filter!=='starred'||c.starred)&&(!query||normalized(c.front).includes(query)||normalized(c.back).includes(query)));
  $('fullListCount').textContent=`${list.length} ${plural(list.length,'слово','слова','слов')} · ★ ${list.filter(c=>c.starred).length} отмечено`;
  const rows=$('fullListRows');rows.replaceChildren();for(const c of list){const row=document.createElement('div');row.className='full-list-row';const star=starButton(c);const pair=document.createElement('div');pair.className='full-list-pair';const front=document.createElement('div');front.className='full-list-front';front.dir='auto';front.textContent=c.front;const back=document.createElement('div');back.className='full-list-back';back.dir='auto';back.textContent=c.back;pair.append(front,back);row.append(star,pair);rows.append(row);}
  if(!list.length){const p=document.createElement('p');p.className='table-empty';p.textContent='Слов по выбранному фильтру нет.';rows.append(p);}
}
function openSplit(deckId){const deck=getDeck(deckId);if(!deck)return;const count=cardsInDeck(deckId).length;if(count<2){toast('Для разделения нужно хотя бы 2 слова');return;}
  splitDeckId=deckId;$('splitDeckInfo').textContent=`«${deck.name}» · ${count} слов. Исходный набор останется целым.`;
  $('splitCount').max=String(Math.min(10,count));$('splitCount').value=String(deck.parts.length>1?deck.parts.length:Math.min(3,count));$('splitSizes').value='';$('splitFeedback').hidden=true;openDialog('splitDialog');
}
function createParts(){const deck=getDeck(splitDeckId);if(!deck)return;
  const cards=cardsInDeck(deck.id),count=Number($('splitCount').value),raw=$('splitSizes').value.trim(),err=$('splitFeedback');err.hidden=true;
  const error=msg=>{err.textContent=msg;err.hidden=false;};
  if(!Number.isInteger(count)||count<2||count>10||count>cards.length){error(`Укажи от 2 до ${Math.min(10,cards.length)} частей.`);return;}
  let sizes;
  if(raw){sizes=raw.split(/[,;\s]+/).filter(Boolean).map(Number);
    if(sizes.length!==count||sizes.some(n=>!Number.isInteger(n)||n<=0)||sizes.reduce((a,b)=>a+b,0)!==cards.length){error(`Количество чисел должно быть ${count}, их сумма — ${cards.length}. Например, через запятую.`);return;}}
  else{const size=Math.floor(cards.length/count),extra=cards.length%count;sizes=Array.from({length:count},(_,i)=>size+(i<extra?1:0));}
  if(deck.parts.length&&!confirm('Переразбить набор? Старые границы частей будут заменены. Слова, звёздочки и статистика сохранятся.'))return;
  deck.parts=sizes.map((_,i)=>({id:uid(),name:`Часть ${i+1}`}));
  let cursor=0;for(let i=0;i<sizes.length;i++){for(let j=0;j<sizes[i];j++)cards[cursor++].partId=deck.parts[i].id;}
  state.prefs.deckId=deck.id;state.prefs.partId=deck.parts[0].id;session=null;save();closeDialog('splitDialog');setView('study');toast(`Создано частей: ${count}. Набор сохранён целиком.`);
}
function renderDecks(){const grid=$('decksGrid');grid.replaceChildren();for(const d of state.decks){
  const card=document.createElement('article');card.className='deck-card';
  const head=document.createElement('div');head.className='deck-head';const info=document.createElement('div');const h=document.createElement('h3');h.textContent=d.name;const p=document.createElement('p');p.textContent=`${d.frontLang} ↔ ${d.backLang}`;info.append(h,p);const badge=document.createElement('div');badge.className='deck-badge';badge.textContent=(d.frontLang||'A').slice(0,1).toLocaleUpperCase();head.append(info,badge);
  const count=document.createElement('div');count.className='deck-count';const list=cardsInDeck(d.id),stars=list.filter(c=>c.starred).length;count.textContent=`${list.length} ${plural(list.length,'слово','слова','слов')} · ★ ${stars}`;
  const acts=document.createElement('div');acts.className='deck-actions';
  const buttons=[['Учить весь набор','primary',()=>{state.prefs.deckId=d.id;state.prefs.partId='all';save();setView('study');startSession();}],['≡ Список слов','secondary',()=>openFullList(d.id)],['✂ Разбить на части','secondary',()=>openSplit(d.id)],['Добавить','secondary',()=>openImport(d.id)],['Изменить','secondary',()=>openDeckDialog(d.id)],['Удалить','secondary',()=>deleteDeck(d.id)]];
  for(const [label,kind,cb] of buttons){const b=document.createElement('button');b.type='button';b.className=`btn btn-${kind}`;b.textContent=label;b.addEventListener('click',cb);acts.append(b);}
  card.append(head,count);
  if(d.parts.length){const parts=document.createElement('div');parts.className='deck-parts';for(const part of d.parts){const partCards=cardsForPart(d.id,part.id),studied=partCards.filter(learnedCard).length;
    const button=document.createElement('button');button.type='button';button.className='deck-part-button';button.textContent=`${part.name} · ${partCards.length} слов · ${studied} повторяли →`;
    button.addEventListener('click',()=>{state.prefs.deckId=d.id;state.prefs.partId=part.id;state.prefs.scope='all';save();setView('study');startSession();});parts.append(button);}
    if(hasUnassigned(d.id)){const text=document.createElement('div');text.className='hint';text.textContent=`Без части: ${cardsForPart(d.id,'unassigned').length} новых слов`;parts.append(text);}card.append(parts);
  }card.append(acts);grid.append(card);
  }if(!state.decks.length){const empty=document.createElement('div');empty.className='empty-state';empty.innerHTML='<h3>Наборов пока нет</h3><p>Создай первый набор, чтобы добавить слова.</p>';grid.append(empty);}
}
function localDay(t){const d=new Date(t);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function renderStats(){const reviewed=state.cards.filter(c=>c.review.forward.seen||c.review.backward.seen).length;const dueCount=state.cards.filter(c=>due(c,'forward')||due(c,'backward')).length;const today=state.reviews.filter(r=>localDay(r.at)===localDay(now())).length;const stats=[['Наборов',state.decks.length],['Всего слов',state.cards.length],['Повторяли',reviewed],['К повторению',dueCount]];const el=$('statsCards');el.replaceChildren();stats.forEach(([name,value])=>{const node=document.createElement('article');node.className='stat-card';const num=document.createElement('div');num.className='number';num.textContent=value;const label=document.createElement('div');label.className='label';label.textContent=name;node.append(num,label);el.append(node);});const chart=$('activityChart');chart.replaceChildren();const days=Array.from({length:7},(_,i)=>{const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()-6+i);return d;});const counts=days.map(d=>state.reviews.filter(r=>localDay(r.at)===localDay(d.getTime())).length);const max=Math.max(1,...counts);days.forEach((d,i)=>{const col=document.createElement('div');col.className='bar-col';const count=document.createElement('div');count.className='count';count.textContent=counts[i];const bar=document.createElement('div');bar.className='bar';bar.style.height=`${Math.max(5,Math.round(counts[i]/max*120))}px`;const day=document.createElement('div');day.className='day';day.textContent=d.toLocaleDateString('ru-RU',{weekday:'short'});col.append(count,bar,day);chart.append(col);});const rows=$('deckStats');rows.replaceChildren();for(const d of state.decks){const list=cardsInDeck(d.id);const got=list.filter(c=>c.review.forward.seen||c.review.backward.seen).length;const row=document.createElement('div');row.className='deck-stat-row';const text=document.createElement('div');text.className='deck-stat-title';const name=document.createElement('span');name.textContent=d.name;const numbers=document.createElement('span');numbers.textContent=`${got}/${list.length}`;text.append(name,numbers);const track=document.createElement('div');track.className='mini-track';const fill=document.createElement('div');fill.style.width=`${list.length?Math.round(got/list.length*100):0}%`;track.append(fill);row.append(text,track);rows.append(row);}if(!state.decks.length)rows.textContent='Создай первый набор.';}
function openDialog(id){const d=$(id);if(!d.open)d.showModal();}
function closeDialog(id){const d=$(id);if(d.open)d.close();}
function openImport(deckId){if(!state.decks.length){toast('Сначала создай набор слов');openDeckDialog();return;}$('bulkWords').value='';$('importWordsFile').value='';$('chosenFile').textContent='';$('importFeedback').textContent='';$('importFeedback').classList.remove('is-error');refreshDeckChoices();$('importDeck').value=deckId||activeDeck().id;openDialog('importDialog');}
function openDeckDialog(id){editDeckId=id||null;const d=id?getDeck(id):null;$('deckDialogTitle').textContent=d?'Изменить набор':'Новый набор';$('deckName').value=d?.name||'';$('deckFrontLang').value=d?.frontLang||'English';$('deckBackLang').value=d?.backLang||'Русский';openDialog('deckDialog');}
function openEditWord(id){const c=state.cards.find(c=>c.id===id);if(!c)return;editCardId=id;const d=getDeck(c.deckId);$('editFrontLabel').textContent=d?.frontLang||'Первый язык';$('editBackLabel').textContent=d?.backLang||'Второй язык';$('editFront').value=c.front;$('editBack').value=c.back;openDialog('wordDialog');}
function deleteDeck(id){const d=getDeck(id);if(!d)return;const num=cardsInDeck(id).length;if(!confirm(`Удалить набор «${d.name}» и все его ${num} слов? Восстановление возможно только из резервной копии.`))return;state.decks=state.decks.filter(x=>x.id!==id);state.cards=state.cards.filter(x=>x.deckId!==id);state.prefs.deckId=state.decks[0]?.id||null;state.prefs.partId='all';session=null;save();render();toast('Набор удалён');}
function deleteWord(id){const c=state.cards.find(x=>x.id===id);if(!c)return;if(!confirm(`Удалить слово «${c.front}»?`))return;state.cards=state.cards.filter(x=>x.id!==id);save();renderWords();toast('Карточка удалена');}
function parseCsv(input,delimiter){const rows=[];let row=[],field='',inQuote=false;for(let i=0;i<input.length;i++){const ch=input[i];if(inQuote){if(ch==='"'&&input[i+1]==='"'){field+='"';i++;}else if(ch==='"'){inQuote=false;}else{field+=ch;}}else if(ch==='"'){inQuote=true;}else if(ch===delimiter){row.push(field);field='';}else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&input[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';}else{field+=ch;}}row.push(field);if(row.some(x=>x.trim()))rows.push(row);return rows;}
function isHeader(a,b){const x=normalized(a),y=normalized(b);const first=/^(word|english|term|front|question|слово|английский|иврит|hebrew|source|original|термин|язык 1|lang 1)$/i;const second=/^(translation|russian|meaning|back|answer|перевод|русский|значение|target|язык 2|lang 2)$/i;return first.test(x)&&second.test(y);}
function cleanPairs(rows){const result=[];for(const row of rows){if(row.length<2)continue;const first=String(row[0]??'').trim().replace(/^\uFEFF/,'');const second=String(row[1]??'').trim();if(!first||!second||isHeader(first,second))continue;result.push([first.slice(0,1000),second.slice(0,1000)]);if(result.length>MAX_IMPORT)throw new Error(`За один раз можно импортировать не больше ${MAX_IMPORT} слов.`);}return result;}
function parseList(input){const lines=input.replace(/^\uFEFF/,'').split(/\r?\n/);const rows=[];let bad=0;for(const l of lines){const line=l.trim();if(!line)continue;let pair=null;
  for(const delim of ['\t',' — ','—',' – ',' –','– ',' | ','|',' → ','→',' = ',' ; ',';',' - ',' : ']){const at=line.indexOf(delim);if(at!==-1){pair=[line.slice(0,at),line.slice(at+delim.length)];break;}}
  if(!pair&&line.includes(',')){const r=parseCsv(line,',');if(r[0]?.length>=2)pair=r[0].slice(0,2);}
  if(pair)rows.push(pair);else bad++;
 }return {pairs:cleanPairs(rows),skipped:bad};}
function parseTextFile(text,filename){const ext=filename.split('.').pop().toLowerCase();if(ext==='csv'||ext==='tsv'){const sample=text.split(/\r?\n/).slice(0,6).join('\n');const delimiter=ext==='tsv'?'\t':['\t',';',','].sort((a,b)=>sample.split(b).length-sample.split(a).length)[0];return {pairs:cleanPairs(parseCsv(text,delimiter).map(r=>r.slice(0,2))),skipped:0};}return parseList(text);}
function xmlNodes(root,tag){return Array.from(root.getElementsByTagNameNS('*',tag));}
function zipPath(parent,target){if(target.startsWith('/'))return target.slice(1);const parts=(parent+'/'+target).split('/'),out=[];for(const p of parts){if(p==='..')out.pop();else if(p&&p!=='.')out.push(p);}return out.join('/');}
async function readXlsx(file){if(!window.JSZip)throw new Error('Модуль Excel не загрузился.');const zip=await JSZip.loadAsync(await file.arrayBuffer());const workbookFile=zip.file('xl/workbook.xml');if(!workbookFile)throw new Error('Не удалось прочитать книгу Excel. Сохрани файл в формате XLSX.');const parser=new DOMParser();const x=async path=>{const f=zip.file(path);if(!f)throw new Error('Не найден лист Excel: '+path);const xml=parser.parseFromString(await f.async('string'),'application/xml');if(xml.querySelector('parsererror'))throw new Error('Повреждённый Excel/XML файл.');return xml;};const wb=await x('xl/workbook.xml');const sheet=xmlNodes(wb,'sheet')[0];if(!sheet)throw new Error('В файле нет листов.');const relid=sheet.getAttribute('r:id')||sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');let sheetPath='xl/worksheets/sheet1.xml';const relFile=zip.file('xl/_rels/workbook.xml.rels');if(relFile&&relid){const relXml=await x('xl/_rels/workbook.xml.rels');const rel=xmlNodes(relXml,'Relationship').find(r=>r.getAttribute('Id')===relid);if(rel){const target=rel.getAttribute('Target');if(target)sheetPath=zipPath('xl',target);}}
  let shared=[];if(zip.file('xl/sharedStrings.xml')){const sst=await x('xl/sharedStrings.xml');shared=xmlNodes(sst,'si').map(si=>xmlNodes(si,'t').map(t=>t.textContent||'').join(''));}
  const xml=await x(sheetPath),rows=[];for(const row of xmlNodes(xml,'row')){const cells=[];for(const cell of Array.from(row.children).filter(c=>c.localName==='c')){const ref=cell.getAttribute('r')||'';const match=ref.match(/^[A-Z]+/i);let idx=match?0:cells.length;if(match){for(const char of match[0].toUpperCase())idx=idx*26+char.charCodeAt(0)-64;idx--;}
     if(idx>200)continue;const type=cell.getAttribute('t');const v=xmlNodes(cell,'v')[0]?.textContent||'';const value=type==='s'?(shared[Number(v)]??''):type==='inlineStr'?xmlNodes(cell,'t').map(t=>t.textContent||'').join(''):v;cells[idx]=value;}
    if(cells.length)rows.push([cells[0]||'',cells[1]||'']);if(rows.length>MAX_IMPORT+500)throw new Error('Слишком много строк в Excel.');}
  return {pairs:cleanPairs(rows),skipped:0};
}
async function doImport(){const deck=getDeck($('importDeck').value);if(!deck){toast('Выбери набор');return;}const btn=$('importDo');btn.disabled=true;const feedback=$('importFeedback');feedback.textContent='Читаем слова…';feedback.classList.remove('is-error');try{const file=$('importWordsFile').files[0];let result;if(file){if(file.size>MAX_FILE)throw new Error('Файл больше 10 МБ.');const ext=file.name.split('.').pop().toLowerCase();if(ext==='xlsx')result=await readXlsx(file);else if(['csv','tsv','txt'].includes(ext))result=parseTextFile(await file.text(),file.name);else throw new Error('Поддерживаются TXT, CSV, TSV, XLSX.');}else result=parseList($('bulkWords').value);if(!result.pairs.length)throw new Error('Не нашёл пар «слово — перевод». Проверь разделители.');const existing=new Set(cardsInDeck(deck.id).map(c=>normalized(c.front)+'\u0000'+normalized(c.back)));let added=0,duplicates=0;for(const [a,b] of result.pairs){const key=normalized(a)+'\u0000'+normalized(b);if(existing.has(key)){duplicates++;continue;}state.cards.push(newCard(deck.id,a,b));existing.add(key);added++;}if(added)await save();render();feedback.textContent=`Добавлено: ${added}. Дубликатов: ${duplicates}. Строк без пары: ${result.skipped||0}.`;toast(`Добавлено ${added} ${plural(added,'слово','слова','слов')}`);if(added){$('bulkWords').value='';$('importWordsFile').value='';$('chosenFile').textContent='';setTimeout(()=>closeDialog('importDialog'),900);}}
catch(e){feedback.classList.add('is-error');feedback.textContent=e.message||'Ошибка импорта';}finally{btn.disabled=false;}}
function filename(name){return String(name||'слова').replace(/[\\/:*?"<>|]/g,'_').slice(0,75);}
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function makeCsv(){const id=$('wordsDeck').value;const deck=getDeck(id);const lines=[['Слово','Перевод']];for(const c of state.cards.filter(c=>id==='all'||c.deckId===id))lines.push([c.front,c.back]);const csv='\uFEFF'+lines.map(row=>row.map(val=>'"'+String(val).replace(/"/g,'""')+'"').join(';')).join('\r\n');download(new Blob([csv],{type:'text/csv;charset=utf-8'}),`${filename(deck?.name||'Все_слова')}.csv`);}
function backup(){download(new Blob([JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2)],{type:'application/json;charset=utf-8'}),`Карточки_копия_${localDay(now())}.json`);toast('Резервная копия сохранена');}
async function restoreBackup(file){if(!file)return;try{if(file.size>MAX_FILE*3)throw new Error('Резервная копия слишком велика.');const parsed=validState(JSON.parse(await file.text()));if(!confirm(`Загрузить копию (${parsed.decks.length} наборов, ${parsed.cards.length} слов)? Текущие данные будут полностью заменены.`))return;session=null;state=parsed;await save();setView('study');toast('Все наборы и прогресс восстановлены');}catch(e){toast(`Ошибка восстановления: ${e.message}`);}finally{$('importBackup').value='';}}
function installPWA(){if(installPrompt){installPrompt.prompt();installPrompt.userChoice.finally(()=>{installPrompt=null;$('installBtn').hidden=true;});}else{toast('Открой меню браузера → «Установить приложение» / «На главный экран»');}}
function speak(){const item=sessionDisplayedItem(),card=state.cards.find(c=>c.id===item?.cardId),deck=getDeck(session?.deckId);if(!item||!card||!deck)return;if(!('speechSynthesis' in window)){toast('Озвучивание не поддерживается браузером');return;}const text=item.dir==='forward'?card.front:card.back;const langName=item.dir==='forward'?deck.frontLang:deck.backLang;const langs={'english':'en-US','английский':'en-US','русский':'ru-RU','russian':'ru-RU','hebrew':'he-IL','иврит':'he-IL','עברית':'he-IL','deutsch':'de-DE','немецкий':'de-DE','français':'fr-FR','французский':'fr-FR','español':'es-ES','испанский':'es-ES','日本語':'ja-JP','японский':'ja-JP'};const utter=new SpeechSynthesisUtterance(text);utter.lang=langs[langName.toLocaleLowerCase()]||'en-US';utter.rate=.85;speechSynthesis.cancel();speechSynthesis.speak(utter);}
function bind(){
  $$('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
  $$('[data-action="open-import"]').forEach(b=>b.addEventListener('click',()=>openImport()));
  $$('[data-dialog-close]').forEach(b=>b.addEventListener('click',()=>closeDialog(b.dataset.dialogClose)));
  for(const dialog of $$('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  $('studyDeck').addEventListener('change',e=>{state.prefs.deckId=e.target.value;state.prefs.partId='all';session=null;save();renderStudy();});
  $('studyPart').addEventListener('change',e=>{state.prefs.partId=e.target.value;session=null;save();renderStudy();});
  for(const [id,key] of [['studyDirection','direction'],['studyMode','mode'],['studyScope','scope']])$(id).addEventListener('change',e=>{state.prefs[key]=e.target.value;save();renderStudy();});
  $('studyShuffle').addEventListener('change',e=>{state.prefs.shuffle=e.target.checked;save();});
  $('startStudy').addEventListener('click',startSession);
  $('openFullList').addEventListener('click',()=>openFullList());
  $('fullListPart').addEventListener('change',renderFullList);$('fullListFilter').addEventListener('change',renderFullList);$('fullListSearch').addEventListener('input',renderFullList);
  $('splitForm').addEventListener('submit',e=>{e.preventDefault();createParts();});
  $('cardStar').addEventListener('click',()=>{const item=sessionDisplayedItem();if(item)toggleStar(item.cardId);});
  $('previousCard').addEventListener('click',historyPrev);$('forwardCard').addEventListener('click',historyNext);
  $('showAnswer').addEventListener('click',revealAnswer);
  $('markKnown').addEventListener('click',()=>gradeCurrent(true));$('markWrong').addEventListener('click',()=>gradeCurrent(false));
  $('endSession').addEventListener('click',()=>{session=null;renderStudy();toast('Тренировка завершена. Результаты сохранены.');});
  $('typeControls').addEventListener('submit',e=>{e.preventDefault();verifyTyped();});
  $('overrideCorrect').addEventListener('click',()=>{if(session&&session.historyIndex===null){session.pendingCorrect=true;showSessionCard();$('typeResult').textContent='✓ Ответ засчитан как правильный.';}});
  $('typeNext').addEventListener('click',()=>{if(session?.pendingCorrect!==null)gradeCurrent(session.pendingCorrect);});
  $('pronounce').addEventListener('click',speak);
  $('wordsDeck').addEventListener('change',renderWords);$('searchWords').addEventListener('input',renderWords);$('wordFilter').addEventListener('change',renderWords);
  $('newDeck').addEventListener('click',()=>openDeckDialog());
  $('deckForm').addEventListener('submit',e=>{e.preventDefault();const name=$('deckName').value.trim(),frontLang=$('deckFrontLang').value.trim(),backLang=$('deckBackLang').value.trim();if(!name||!frontLang||!backLang)return;if(editDeckId){const d=getDeck(editDeckId);if(d)Object.assign(d,{name,frontLang,backLang});}else{const id=uid();state.decks.push({id,name,frontLang,backLang,parts:[],createdAt:now()});state.prefs.deckId=id;state.prefs.partId='all';}save();closeDialog('deckDialog');render();toast('Набор сохранён');});
  $('wordForm').addEventListener('submit',e=>{e.preventDefault();const c=state.cards.find(c=>c.id===editCardId);if(!c)return;const a=$('editFront').value.trim(),b=$('editBack').value.trim();if(!a||!b)return;c.front=a;c.back=b;save();closeDialog('wordDialog');renderWords();toast('Карточка изменена');});
  $('importWordsFile').addEventListener('change',e=>{$('chosenFile').textContent=e.target.files[0]?`Выбран файл: ${e.target.files[0].name}`:'';if(e.target.files[0])$('bulkWords').value='';});
  $('bulkWords').addEventListener('input',()=>{if($('importWordsFile').files.length){$('importWordsFile').value='';$('chosenFile').textContent='';}});
  $('importDo').addEventListener('click',doImport);$('exportCsv').addEventListener('click',makeCsv);$('exportBackup').addEventListener('click',backup);
  $('importBackup').addEventListener('change',e=>restoreBackup(e.target.files[0]));
  $('persistStorage').addEventListener('click',async()=>{if(!navigator.storage?.persist){$('storageResult').textContent='Браузер не поддерживает эту функцию. Пользуйся резервными копиями.';return;}const ok=await navigator.storage.persist();$('storageResult').textContent=ok?'Браузер разрешил постоянное хранение. Всё равно рекомендуем резервные копии.':'Браузер не предоставил постоянное хранение. Рекомендуем резервные копии.';});
  $('installBtn').addEventListener('click',installPWA);
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('installBtn').hidden=false;});
  window.addEventListener('appinstalled',()=>{$('installBtn').hidden=true;toast('Приложение установлено!');});
  document.addEventListener('keydown',e=>{if(activeView!=='study'||!session||e.altKey||e.ctrlKey||e.metaKey)return;const el=e.target;if(['INPUT','TEXTAREA','SELECT'].includes(el.tagName)||el.closest('dialog'))return;if(session.historyIndex!==null){if(e.key==='ArrowLeft')historyPrev();else if(e.key==='ArrowRight')historyNext();return;}if(e.key==='ArrowLeft'){e.preventDefault();historyPrev();return;}if(session.mode==='flip'){if((e.code==='Space'||e.key==='Enter')&&$('cardAnswer').hidden){e.preventDefault();revealAnswer();}else if(!$('cardAnswer').hidden&&e.key==='1')gradeCurrent(false);else if(!$('cardAnswer').hidden&&e.key==='2')gradeCurrent(true);}});
}
async function registerServiceWorker(){if('serviceWorker' in navigator&&location.protocol.startsWith('http')){try{await navigator.serviceWorker.register('./service-worker.js',{scope:'./'});}catch(e){console.warn('Service worker:',e);}}}
async function init(){try{db=await openDb();const saved=await dbGet();state=saved?validState(saved):startData();if(!saved)await dbPut(state);$('loading').hidden=true;$('app').hidden=false;summaryEl=document.createElement('div');summaryEl.className='empty-state';summaryEl.hidden=true;summaryEl.innerHTML='<div class="empty-illustration">✓</div><h3>Готово!</h3><p></p><button type="button" class="btn btn-primary">Повторить тренировку</button>';$('session').after(summaryEl);bind();render();registerServiceWorker();}
catch(e){console.error(e);$('loading').hidden=true;$('errorScreen').hidden=false;$('fatalText').textContent=`${e.message||'Неизвестная ошибка'}. Попробуй обычную вкладку браузера вместо режима инкогнито.`;}}
init();
})();
