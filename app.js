(() => {
  "use strict";
  const cfg = window.COMIDITAS_CONFIG || {};
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.includes("PEGAR_") && !cfg.SUPABASE_ANON_KEY.includes("PEGAR_");
  const allowSignup = cfg.ALLOW_SIGNUP !== false;
  const $ = id => document.getElementById(id);
  let sb = null, user = null, activeSpace = "mine", activeView = "meals", activeCategory = "Todas";
  let selectedPhotos = [], detailType = null, detailId = null;
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const notify = message => { const t=$("toast");t.textContent=message;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2600); };
  const closeDialogs = () => document.querySelectorAll("dialog[open]").forEach(d=>d.close());
  const showError = e => { console.error(e); notify(e?.message || "Ocurrió un error. Revisá la conexión e intentá de nuevo."); };

  async function all(table) {
    const {data,error}=await sb.from(table).select("*").order("created_at",{ascending:false});
    if(error) throw error;
    if(table!=="meals") return data||[];
    return Promise.all((data||[]).map(async m=>{
      let photo=null;
      if(m.photo_path){const {data:signed,error:signErr}=await sb.storage.from("meal-photos").createSignedUrl(m.photo_path,3600);if(!signErr)photo=signed.signedUrl;}
      return {...m, forMilla:m.for_milla, photo, photo_path:m.photo_path};
    }));
  }
  async function uploadPhoto(dataUrl, path) {
    const response=await fetch(dataUrl);const blob=await response.blob();
    const ext=(blob.type.split("/")[1]||"jpg").replace("jpeg","jpg").replace(/[^a-z0-9]/gi,"");
    const finalPath=`${user.id}/${path}.${ext||"jpg"}`;
    const {error}=await sb.storage.from("meal-photos").upload(finalPath,blob,{contentType:blob.type||"image/jpeg",upsert:true});
    if(error) throw error;return finalPath;
  }
  async function saveMeal(m) {
    const payload={id:m.id||uid(),user_id:user.id,name:m.name,ingredients:m.ingredients||"",category:m.category,for_milla:!!m.forMilla,photo_path:m.photo_path||null};
    if(m.photoData) payload.photo_path=await uploadPhoto(m.photoData,payload.id);
    const {error}=await sb.from("meals").upsert(payload);if(error)throw error;
  }
  async function deleteItem(table,id) {
    if(table==="meals"){
      const {data}=await sb.from("meals").select("photo_path").eq("id",id).maybeSingle();
      if(data?.photo_path) await sb.storage.from("meal-photos").remove([data.photo_path]);
    }
    const {error}=await sb.from(table).delete().eq("id",id);if(error)throw error;
  }
  async function render() {
    if(!user)return;
    const meals=await all("meals"), recipes=await all("recipes"), q=$("searchInput").value.trim().toLowerCase();
    $("mealView").hidden=activeView!=="meals";$("recipeView").hidden=activeView!=="recipes";$("filters").hidden=activeView!=="meals";$("clearSearch").hidden=!q;
    document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.view===activeView));
    document.body.classList.toggle("milla",activeSpace==="milla");
    document.querySelectorAll(".space").forEach(b=>b.classList.toggle("active",b.dataset.space===activeSpace));
    document.querySelectorAll(".filter").forEach(b=>b.classList.toggle("active",b.dataset.category===activeCategory));
    const filtered=meals.filter(m=>(activeSpace==="mine"||m.forMilla)&&(activeCategory==="Todas"||m.category===activeCategory)&&`${m.name} ${m.ingredients}`.toLowerCase().includes(q));
    $("mealGrid").innerHTML=filtered.map(m=>`<article class="meal-card">${m.photo?`<img class="meal-photo" src="${m.photo}" alt="${escapeHTML(m.name)}">`:`<div class="meal-photo photo-placeholder">▧</div>`}<div class="meal-title-row"><button class="meal-title" data-detail-meal="${m.id}" style="border:0;background:none;text-align:left;padding:0;color:inherit">${escapeHTML(m.name)}</button><button class="heart ${m.forMilla?"marked":""}" data-heart="${m.id}" aria-label="Marcar para Millá">${m.forMilla?"♥":"♡"}</button></div><div class="meal-category">${escapeHTML(m.category)}</div></article>`).join("");
    $("emptyMeals").hidden=filtered.length>0;
    const filteredRecipes=recipes.filter(r=>`${r.name} ${r.ingredients} ${r.steps}`.toLowerCase().includes(q));
    $("recipeList").innerHTML=filteredRecipes.map(r=>`<button class="recipe-card" data-detail-recipe="${r.id}"><span class="recipe-icon">▤</span><span><strong>${escapeHTML(r.name)}</strong><small>${escapeHTML((r.ingredients||"").slice(0,75)||"Sin ingredientes cargados")}</small></span></button>`).join("");
    $("emptyRecipes").hidden=filteredRecipes.length>0;
  }
  function resetMealForm(){ $("mealForm").reset();$("mealId").value="";$("mealDialogTitle").textContent="Agregar comida";selectedPhotos=[];$("photoPreview").innerHTML=""; }
  async function filesToPhotos(files){const out=[];for(const file of files){if(!file.type.startsWith("image/"))continue;out.push({name:file.name,data:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);})});}return out;}
  function previewPhotos(){ $("photoPreview").innerHTML=selectedPhotos.map(p=>`<img src="${p.data}" alt="${escapeHTML(p.name)}">`).join(""); }
  async function handleFiles(input){try{const fresh=await filesToPhotos([...input.files]);selectedPhotos.push(...fresh);previewPhotos();if(fresh.length===1&&!$("mealName").value)$("mealName").value=fresh[0].name.replace(/\.[^.]+$/," ").replace(/[_-]+/g," ").trim();if(fresh.length>1)notify(`${fresh.length} fotos seleccionadas`);}catch(e){showError(e);}input.value="";}
  async function openMealEditor(id=null){
    resetMealForm();
    if(id){const m=(await all("meals")).find(x=>x.id===id);if(!m)return;$("mealId").value=m.id;$("mealDialogTitle").textContent="Editar comida";$("mealName").value=m.name;$("mealIngredients").value=m.ingredients||"";$("mealCategory").value=m.category;$("mealForMilla").checked=!!m.forMilla;$("photoPreview").innerHTML=m.photo?`<img src="${m.photo}" alt="Foto actual">`:"";}
    $("mealDialog").showModal();
  }
  async function openRecipeEditor(id=null){
    $("recipeForm").reset();$("recipeId").value="";$("recipeDialogTitle").textContent="Agregar receta";
    if(id){const r=(await all("recipes")).find(x=>x.id===id);if(!r)return;$("recipeId").value=r.id;$("recipeDialogTitle").textContent="Editar receta";$("recipeName").value=r.name;$("recipeIngredients").value=r.ingredients||"";$("recipeSteps").value=r.steps||"";}
    $("recipeDialog").showModal();
  }
  async function showDetail(type,id){
    detailType=type;detailId=id;const record=(await all(type==="meal"?"meals":"recipes")).find(x=>x.id===id);if(!record)return;
    $("detailTitle").textContent=record.name;
    $("detailContent").innerHTML=type==="meal"?`${record.photo?`<img class="detail-photo" src="${record.photo}" alt="">`:""}<p class="detail-label">INGREDIENTES</p><div class="detail-copy">${escapeHTML(record.ingredients||"Sin ingredientes cargados")}</div><p class="detail-label">CATEGORÍA</p><div class="detail-copy">${escapeHTML(record.category)}</div>`:`<p class="detail-label">INGREDIENTES</p><div class="detail-copy">${escapeHTML(record.ingredients||"Sin ingredientes cargados")}</div><p class="detail-label">PREPARACIÓN</p><div class="detail-copy">${escapeHTML(record.steps||"Sin preparación cargada")}</div>`;
    $("detailDialog").showModal();
  }
  function setLoggedIn(session){user=session?.user||null;$ ("authGate").hidden=!!user;$("mainApp").hidden=!user;if(user){render().catch(showError);}}
  async function authAction(mode){
    $("signUpButton").hidden = !allowSignup;
  if(!allowSignup) $("authMessage").textContent = "Registro cerrado. Iniciá sesión con tu cuenta.";
  if(!configured){$("authMessage").textContent="Falta conectar Supabase. Completá config.js con la URL y la clave pública de tu proyecto.";return;}
    const email=$("authEmail").value.trim(),password=$("authPassword").value;
    if(!email||!password){notify("Ingresá correo y contraseña.");return;}
    const btn=mode==="in"?$("signInButton"):$ ("signUpButton");btn.disabled=true;
    try{
      const result=mode==="in"?await sb.auth.signInWithPassword({email,password}):await sb.auth.signUp({email,password});
      if(result.error)throw result.error;
      if(mode==="up"&&!result.data.session)$("authMessage").textContent="Cuenta creada. Revisá tu correo para confirmar el registro y después iniciá sesión.";
      else notify(mode==="up"?"Cuenta creada.":"Sesión iniciada.");
      if(result.data.session)setLoggedIn(result.data.session);
    }catch(e){showError(e);}finally{btn.disabled=false;}
  }
  document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.close).close()));
  $("quickAdd").onclick=$("addMealFooter").onclick=()=>openMealEditor().catch(showError);
  $("addRecipeFooter").onclick=()=>openRecipeEditor().catch(showError);
  $("galleryInput").addEventListener("change",e=>handleFiles(e.target));$("cameraInput").addEventListener("change",e=>handleFiles(e.target));
  $("searchInput").addEventListener("input",()=>render().catch(showError));$("clearSearch").onclick=()=>{$("searchInput").value="";render().catch(showError);};
  document.querySelectorAll(".space").forEach(b=>b.onclick=()=>{activeSpace=b.dataset.space;render().catch(showError);});
  document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{activeView=b.dataset.view;render().catch(showError);});
  document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{activeCategory=b.dataset.category;render().catch(showError);});
  $("mealGrid").addEventListener("click",async e=>{try{const heart=e.target.closest("[data-heart]");if(heart){const m=(await all("meals")).find(x=>x.id===heart.dataset.heart);if(m){m.forMilla=!m.forMilla;await saveMeal(m);await render();}return;}const d=e.target.closest("[data-detail-meal]");if(d)await showDetail("meal",d.dataset.detailMeal);}catch(err){showError(err);}});
  $("recipeList").addEventListener("click",e=>{const b=e.target.closest("[data-detail-recipe]");if(b)showDetail("recipe",b.dataset.detailRecipe).catch(showError);});
  $("mealForm").addEventListener("submit",async e=>{
    e.preventDefault();const id=$("mealId").value,name=$("mealName").value.trim();if(!name)return;
    try{
      const old=id?(await all("meals")).find(m=>m.id===id):null;
      const base={id:id||uid(),name,ingredients:$("mealIngredients").value.trim(),category:$("mealCategory").value,forMilla:$("mealForMilla").checked,photo_path:old?.photo_path||null};
      if(id){base.photoData=selectedPhotos.length?selectedPhotos[0].data:null;await saveMeal(base);}
      else if(selectedPhotos.length){for(let i=0;i<selectedPhotos.length;i++)await saveMeal({...base,id:uid(),name:selectedPhotos.length>1&&i>0?`${name} ${i+1}`:name,photoData:selectedPhotos[i].data});}
      else await saveMeal(base);
      closeDialogs();activeView="meals";notify("Guardado en tu cuenta");await render();
    }catch(err){showError(err);}
  });
  $("recipeForm").addEventListener("submit",async e=>{e.preventDefault();try{const id=$("recipeId").value;const recipe={id:id||uid(),user_id:user.id,name:$("recipeName").value.trim(),ingredients:$("recipeIngredients").value.trim(),steps:$("recipeSteps").value.trim()};if(!recipe.name)return;const {error}=await sb.from("recipes").upsert(recipe);if(error)throw error;closeDialogs();activeView="recipes";notify("Receta guardada en tu cuenta");await render();}catch(err){showError(err);}});
  $("editDetail").onclick=async()=>{const type=detailType,id=detailId;closeDialogs();try{if(type==="meal")await openMealEditor(id);else await openRecipeEditor(id);}catch(e){showError(e);}};
  $("deleteDetail").onclick=async()=>{if(!detailId||!confirm("¿Eliminar este elemento?"))return;try{await deleteItem(detailType==="meal"?"meals":"recipes",detailId);closeDialogs();notify("Eliminado");await render();}catch(e){showError(e);}};
  $("authForm").addEventListener("submit",e=>{e.preventDefault();authAction("in");});$("signUpButton").onclick=()=>{if(allowSignup)authAction("up");};
  $("signOutButton").onclick=async()=>{if(confirm("¿Cerrar sesión?")){const {error}=await sb.auth.signOut();if(error)showError(error);else{user=null;$("mainApp").hidden=true;$("authGate").hidden=false;}}};
  $("signUpButton").hidden = !allowSignup;
  if(!allowSignup) $("authMessage").textContent = "Registro cerrado. Iniciá sesión con tu cuenta.";
  if(!configured){$("authMessage").textContent="Para activar el acceso privado, conectá tu proyecto Supabase en config.js. Después podrás crear tu cuenta e iniciar sesión.";$("authGate").hidden=false;$("mainApp").hidden=true;}
  else if(!window.supabase?.createClient){$("authMessage").textContent="No se pudo cargar el servicio de acceso. Revisá tu conexión e intentá recargar.";}
  else {sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);sb.auth.onAuthStateChange((_event,session)=>setLoggedIn(session));sb.auth.getSession().then(({data})=>setLoggedIn(data.session)).catch(showError);}
})();
