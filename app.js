(() => {
  "use strict";
  const DB_NAME = "comiditas-db", DB_VERSION = 1;
  let db, activeSpace = "mine", activeView = "meals", activeCategory = "Todas";
  let selectedPhotos = [], detailType = null, detailId = null;
  const $ = id => document.getElementById(id);
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestDB = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("meals")) d.createObjectStore("meals", {keyPath:"id"});
      if (!d.objectStoreNames.contains("recipes")) d.createObjectStore("recipes", {keyPath:"id"});
    };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  const store = (name, mode="readonly") => db.transaction(name, mode).objectStore(name);
  const getAll = name => new Promise((resolve,reject) => { const r=store(name).getAll(); r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
  const save = (name,item) => new Promise((resolve,reject) => { const r=store(name,"readwrite").put(item);r.onsuccess=()=>resolve(item);r.onerror=()=>reject(r.error); });
  const remove = (name,id) => new Promise((resolve,reject) => { const r=store(name,"readwrite").delete(id);r.onsuccess=resolve;r.onerror=()=>reject(r.error); });
  const escapeHTML = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const notify = message => { const t=$("toast");t.textContent=message;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2400); };
  const dialogOpen = id => $(id).showModal();
  const closeDialogs = () => document.querySelectorAll("dialog[open]").forEach(d=>d.close());

  async function render() {
    const meals=await getAll("meals"), recipes=await getAll("recipes"), q=$("searchInput").value.trim().toLowerCase();
    $("mealView").hidden=activeView!=="meals"; $("recipeView").hidden=activeView!=="recipes";
    $("filters").hidden=activeView!=="meals"; $("clearSearch").hidden=!q;
    document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.view===activeView));
    document.body.classList.toggle("milla",activeSpace==="milla");
    document.querySelectorAll(".space").forEach(b=>b.classList.toggle("active",b.dataset.space===activeSpace));
    document.querySelectorAll(".filter").forEach(b=>b.classList.toggle("active",b.dataset.category===activeCategory));
    const filtered=meals.filter(m=>(activeSpace==="mine"||m.forMilla)&&(activeCategory==="Todas"||m.category===activeCategory)&&`${m.name} ${m.ingredients}`.toLowerCase().includes(q));
    $("mealGrid").innerHTML=filtered.map(m=>`<article class="meal-card">
      ${m.photo?`<img class="meal-photo" src="${m.photo}" alt="${escapeHTML(m.name)}">`:`<div class="meal-photo photo-placeholder" aria-label="Sin foto">▧</div>`}
      <div class="meal-title-row"><button class="meal-title plain" data-detail-meal="${m.id}" style="border:0;background:none;text-align:left;padding:0;color:inherit">${escapeHTML(m.name)}</button>
      <button class="heart ${m.forMilla?"marked":""}" data-heart="${m.id}" aria-label="Marcar para Millá">${m.forMilla?"♥":"♡"}</button></div>
      <div class="meal-category">${escapeHTML(m.category)}</div></article>`).join("");
    $("emptyMeals").hidden=filtered.length>0;
    $("recipeList").innerHTML=recipes.filter(r=>`${r.name} ${r.ingredients} ${r.steps}`.toLowerCase().includes(q)).map(r=>`<button class="recipe-card" data-detail-recipe="${r.id}"><span class="recipe-icon">▤</span><span><strong>${escapeHTML(r.name)}</strong><small>${escapeHTML((r.ingredients||"").slice(0,75)||"Sin ingredientes cargados")}</small></span></button>`).join("");
    $("emptyRecipes").hidden=recipes.some(r=>`${r.name} ${r.ingredients} ${r.steps}`.toLowerCase().includes(q));
  }
  function resetMealForm(){ $("mealForm").reset();$("mealId").value="";$("mealDialogTitle").textContent="Agregar comida";selectedPhotos=[];$("photoPreview").innerHTML=""; }
  async function filesToPhotos(files){ const result=[];for(const file of files){if(!file.type.startsWith("image/"))continue;result.push({name:file.name,data:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);})});}return result; }
  function previewPhotos(){ $("photoPreview").innerHTML=selectedPhotos.map(p=>`<img src="${p.data}" alt="${escapeHTML(p.name)}">`).join(""); }
  async function handleFiles(input){try{const fresh=await filesToPhotos([...input.files]);selectedPhotos.push(...fresh);previewPhotos();if(fresh.length===1&&!$("mealName").value)$("mealName").value=fresh[0].name.replace(/\.[^.]+$/,"").replace(/[_-]+/g," ");if(fresh.length>1)notify(`${fresh.length} fotos seleccionadas`);}catch{notify("No se pudieron abrir esas fotos.");}input.value="";}
  async function openMealEditor(id=null){
    resetMealForm();
    if(id){const m=(await getAll("meals")).find(x=>x.id===id);if(!m)return;$("mealId").value=m.id;$("mealDialogTitle").textContent="Editar comida";$("mealName").value=m.name;$("mealIngredients").value=m.ingredients||"";$("mealCategory").value=m.category;$("mealForMilla").checked=!!m.forMilla;if(m.photo){selectedPhotos=[{name:m.name,data:m.photo}];previewPhotos();}}
    dialogOpen("mealDialog");
  }
  async function openRecipeEditor(id=null){
    $("recipeForm").reset();$("recipeId").value="";$("recipeDialogTitle").textContent="Agregar receta";
    if(id){const r=(await getAll("recipes")).find(x=>x.id===id);if(!r)return;$("recipeId").value=r.id;$("recipeDialogTitle").textContent="Editar receta";$("recipeName").value=r.name;$("recipeIngredients").value=r.ingredients||"";$("recipeSteps").value=r.steps||"";}
    dialogOpen("recipeDialog");
  }
  async function showDetail(type,id){
    detailType=type;detailId=id;
    const record=(await getAll(type==="meal"?"meals":"recipes")).find(x=>x.id===id);if(!record)return;
    $("detailTitle").textContent=record.name;
    $("detailContent").innerHTML=type==="meal"?`${record.photo?`<img class="detail-photo" src="${record.photo}" alt="">`:""}<p class="detail-label">INGREDIENTES</p><div class="detail-copy">${escapeHTML(record.ingredients||"Sin ingredientes cargados")}</div><p class="detail-label">CATEGORÍA</p><div class="detail-copy">${escapeHTML(record.category)}</div>`:`<p class="detail-label">INGREDIENTES</p><div class="detail-copy">${escapeHTML(record.ingredients||"Sin ingredientes cargados")}</div><p class="detail-label">PREPARACIÓN</p><div class="detail-copy">${escapeHTML(record.steps||"Sin preparación cargada")}</div>`;
    dialogOpen("detailDialog");
  }
  document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.close).close()));
  $("quickAdd").onclick=$("addMealFooter").onclick=()=>openMealEditor();
  $("addRecipeFooter").onclick=()=>openRecipeEditor();
  $("galleryInput").addEventListener("change",e=>handleFiles(e.target));
  $("cameraInput").addEventListener("change",e=>handleFiles(e.target));
  $("searchInput").addEventListener("input",render);
  $("clearSearch").onclick=()=>{$("searchInput").value="";render();};
  document.querySelectorAll(".space").forEach(b=>b.onclick=()=>{activeSpace=b.dataset.space;render();});
  document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{activeView=b.dataset.view;render();});
  document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{activeCategory=b.dataset.category;render();});
  $("mealGrid").addEventListener("click",async e=>{
    const heart=e.target.closest("[data-heart]");if(heart){const m=(await getAll("meals")).find(x=>x.id===heart.dataset.heart);if(m){m.forMilla=!m.forMilla;await save("meals",m);render();}return;}
    const detail=e.target.closest("[data-detail-meal]");if(detail)showDetail("meal",detail.dataset.detailMeal);
  });
  $("recipeList").addEventListener("click",e=>{const b=e.target.closest("[data-detail-recipe]");if(b)showDetail("recipe",b.dataset.detailRecipe);});
  $("mealForm").addEventListener("submit",async e=>{
    e.preventDefault();const id=$("mealId").value, name=$("mealName").value.trim();if(!name)return;
    const base={name,ingredients:$("mealIngredients").value.trim(),category:$("mealCategory").value,forMilla:$("mealForMilla").checked};
    if(id){const old=(await getAll("meals")).find(m=>m.id===id);await save("meals",{...old,...base,photo:selectedPhotos.length?selectedPhotos[0].data:(old?.photo||null)});}
    else if(selectedPhotos.length){for(let i=0;i<selectedPhotos.length;i++){await save("meals",{id:uid(),...base,name:selectedPhotos.length>1&&i>0?`${name} ${i+1}`:name,photo:selectedPhotos[i].data});}}
    else await save("meals",{id:uid(),...base,photo:null});
    closeDialogs();activeView="meals";notify("Guardado");await render();
  });
  $("recipeForm").addEventListener("submit",async e=>{
    e.preventDefault();const id=$("recipeId").value;const recipe={id:id||uid(),name:$("recipeName").value.trim(),ingredients:$("recipeIngredients").value.trim(),steps:$("recipeSteps").value.trim()};if(!recipe.name)return;await save("recipes",recipe);closeDialogs();activeView="recipes";notify("Receta guardada");render();
  });
  $("editDetail").onclick=async()=>{const type=detailType,id=detailId;closeDialogs();if(type==="meal")await openMealEditor(id);else await openRecipeEditor(id);};
  $("deleteDetail").onclick=async()=>{if(!detailId||!confirm("¿Eliminar este elemento?"))return;await remove(detailType==="meal"?"meals":"recipes",detailId);closeDialogs();notify("Eliminado");render();};
  (async()=>{try{db=await requestDB();await render();}catch(err){console.error(err);notify("No se pudo abrir el almacenamiento. Probá en Safari o Chrome actualizado.");}})();
  if("serviceWorker" in navigator && location.protocol.startsWith("http"))navigator.serviceWorker.register("./sw.js").catch(()=>{});
})();