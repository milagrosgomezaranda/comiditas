(() => {
  "use strict";

  const cfg = window.COMIDITAS_CONFIG || {};
  const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.includes("PEGAR_") && !cfg.SUPABASE_ANON_KEY.includes("PEGAR_"));
  const $ = id => document.getElementById(id);

  let sb = null;
  let user = null;
  let activeSpace = "mine";
  let activeView = "meals";
  let activeCategory = "Todas";
  const GRID_COLUMNS_KEY = "comiditas:meal-grid-columns";
  let gridColumns = readGridColumns();
  let selectedPhotos = [];
  let selectedRecipePhoto = null;
  let bulkPhotos = [];
  let bulkGroups = [];
  let bulkStep = 1;
  let bulkSaveInFlight = false;
  let detailType = null;
  let detailId = null;
  let toastTimer = null;
  let mealSaveInFlight = false;
  let recipeSaveInFlight = false;
  let mealSelectionMode = false;
  const selectedMealIds = new Set();
  let mealPressTimer = null;
  let suppressMealClick = false;
  let pendingDeleteMealIds = [];

  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const hasText = value => typeof value === "string" && value.trim().length > 0;

  function readGridColumns() {
    try {
      return localStorage.getItem(GRID_COLUMNS_KEY) === "1" ? 1 : 2;
    } catch {
      return 2;
    }
  }

  function setGridColumns(value) {
    gridColumns = Number(value) === 1 ? 1 : 2;
    try { localStorage.setItem(GRID_COLUMNS_KEY, String(gridColumns)); } catch {}
    applyGridColumns();
  }

  function applyGridColumns() {
    const grid = $("mealGrid");
    if (!grid) return;
    grid.classList.toggle("grid-one", gridColumns === 1);
    grid.classList.toggle("grid-two", gridColumns === 2);
    document.querySelectorAll("[data-grid-columns]").forEach(button => {
      const active = Number(button.dataset.gridColumns) === gridColumns;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function notify(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  function setFormStatus(id, message = "", success = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
    el.classList.toggle("success", Boolean(success));
  }

  function readableError(error) {
    const message = error?.message || "Ocurrió un error. Revisá la conexión e intentá de nuevo.";
    const code = error?.code ? ` [${error.code}]` : "";
    if (/column .* does not exist|schema cache|favorite|time_minutes|servings|photo_path/i.test(message)) return `Falta aplicar la migración v2 de Supabase.${code}`;
    if (/row-level security|permission denied|42501/i.test(`${message} ${error?.code || ""}`)) return `Supabase bloqueó el guardado por permisos/RLS.${code}`;
    return `${message}${code}`;
  }

  function showError(error) {
    console.error("Comiditas error:", error);
    notify(readableError(error));
  }

  function closeDialogs() {
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  }

  async function authHelper(action, password = null) {
    const response = await fetch(`${cfg.SUPABASE_URL}/functions/v1/auth-helper`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ action, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "No se pudo completar el acceso.");
    return body;
  }

  async function signedPhoto(path) {
    if (!path) return null;
    const { data, error } = await sb.storage.from("meal-photos").createSignedUrl(path, 3600);
    if (error) return null;
    return data.signedUrl;
  }

  async function all(table) {
    const { data, error } = await sb.from(table).select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return Promise.all((data || []).map(async record => ({
      ...record,
      forMilla: Boolean(record.for_milla),
      favorite: Boolean(record.favorite),
      photo: await signedPhoto(record.photo_path),
    })));
  }

  async function mealPhotos(mealId) {
    const { data, error } = await sb.from("meal_photos").select("*").eq("meal_id", mealId).eq("user_id", user.id).order("position", { ascending: true });
    if (error) { if (error.code === "42P01" || /meal_photos/i.test(error.message || "")) return []; throw error; }
    return Promise.all((data || []).map(async item => ({ ...item, url: await signedPhoto(item.photo_path) })));
  }

  async function uploadPhoto(dataUrl, path) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const rawExt = blob.type.split("/")[1] || "jpg";
    const ext = rawExt.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    const finalPath = `${user.id}/${path}.${ext}`;
    const { error } = await sb.storage.from("meal-photos").upload(finalPath, blob, {
      contentType: blob.type || "image/jpeg",
      upsert: true,
    });
    if (error) throw error;
    return finalPath;
  }

  async function saveMeal(meal) {
    if (!user?.id) throw new Error("No hay una sesión válida para guardar la comida.");
    const isEditing = Boolean(meal.isEditing);
    const payload = {
      id: meal.id || uid(),
      user_id: user.id,
      name: meal.name,
      ingredients: meal.ingredients || "",
      category: meal.category,
      for_milla: Boolean(meal.forMilla),
      favorite: Boolean(meal.favorite),
      photo_path: meal.photo_path || null,
    };
    if (meal.photoData) {
      const previousPath = payload.photo_path;
      payload.photo_path = await uploadPhoto(meal.photoData, `meals/${payload.id}`);
      if (previousPath && previousPath !== payload.photo_path) await sb.storage.from("meal-photos").remove([previousPath]);
    }

    let result;
    if (isEditing) {
      const updatePayload = { ...payload };
      delete updatePayload.id;
      delete updatePayload.user_id;
      result = await sb.from("meals").update(updatePayload).eq("id", payload.id).eq("user_id", user.id).select("id").maybeSingle();
    } else {
      result = await sb.from("meals").insert(payload).select("id").single();
    }
    if (result.error) throw result.error;
    if (!result.data?.id) throw new Error("Supabase no confirmó el guardado de la comida.");
    return result.data.id;
  }

  async function saveRecipe(recipe) {
    if (!user?.id) throw new Error("No hay una sesión válida para guardar la receta.");
    const isEditing = Boolean(recipe.isEditing);
    const payload = {
      id: recipe.id || uid(),
      user_id: user.id,
      name: recipe.name,
      ingredients: recipe.ingredients || "",
      steps: recipe.steps || "",
      time_minutes: recipe.timeMinutes || null,
      servings: recipe.servings || null,
      category: recipe.category || null,
      favorite: Boolean(recipe.favorite),
      photo_path: recipe.photo_path || null,
    };
    if (recipe.photoData) {
      const previousPath = payload.photo_path;
      payload.photo_path = await uploadPhoto(recipe.photoData, `recipes/${payload.id}`);
      if (previousPath && previousPath !== payload.photo_path) await sb.storage.from("meal-photos").remove([previousPath]);
    }

    let result;
    if (isEditing) {
      const updatePayload = { ...payload };
      delete updatePayload.id;
      delete updatePayload.user_id;
      result = await sb.from("recipes").update(updatePayload).eq("id", payload.id).eq("user_id", user.id).select("id").maybeSingle();
    } else {
      result = await sb.from("recipes").insert(payload).select("id").single();
    }
    if (result.error) throw result.error;
    if (!result.data?.id) throw new Error("Supabase no confirmó el guardado de la receta.");
    return result.data.id;
  }

  async function deleteItem(table, id) {
    const { data } = await sb.from(table).select("photo_path").eq("id", id).maybeSingle();
    let paths = data?.photo_path ? [data.photo_path] : [];
    if (table === "meals") { const extras = await mealPhotos(id); paths = [...new Set([...paths, ...extras.map(item => item.photo_path)])]; }
    if (paths.length) await sb.storage.from("meal-photos").remove(paths);
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw error;
  }

  function matchesSpace(record, type) {
    if (activeSpace === "milla") return type === "meal" && Boolean(record.forMilla);
    return true;
  }

  function mealCard(meal) {
    const selected = selectedMealIds.has(meal.id);
    return `<article class="meal-card ${selected ? "selected" : ""}" data-meal-card="${meal.id}">
      <div class="photo-shell">
        ${meal.photo ? `<img class="meal-photo" src="${escapeHTML(meal.photo)}" alt="${escapeHTML(meal.name)}">` : `<div class="meal-photo photo-placeholder">Sin foto</div>`}
        ${meal.forMilla ? `<span class="milla-indicator" aria-label="Millá"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/></svg></span>` : ""}
        <span class="selection-check" aria-hidden="true">✓</span>
      </div>
      <div class="meal-title">${escapeHTML(meal.name)}</div>
      <div class="meal-actions" role="group" aria-label="Acciones para ${escapeHTML(meal.name)}">
        <button class="meal-action milla-action ${meal.forMilla ? "active" : ""}" type="button" data-milla-meal="${meal.id}" aria-label="${meal.forMilla ? "Quitar de Millá" : "Marcar también para Millá"}" aria-pressed="${meal.forMilla ? "true" : "false"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/></svg></button>
        <button class="meal-action edit-action" type="button" data-edit-meal="${meal.id}" aria-label="Editar ${escapeHTML(meal.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.6-10.6-4-4L4 16v4Zm12.1-16.1 4 4 1.2-1.2a1.4 1.4 0 0 0 0-2l-2-2a1.4 1.4 0 0 0-2 0l-1.2 1.2Z"/></svg></button>
        <button class="meal-action delete-action" type="button" data-delete-meal="${meal.id}" aria-label="Eliminar ${escapeHTML(meal.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l1 2h4v2H3V6h4l1-2Zm-2 6h12l-1 10H7L6 10Zm4 2v6h2v-6h-2Zm4 0v6h2v-6h-2Z"/></svg></button>
      </div>
    </article>`;
  }

  function recipeCard(recipe) {
    const meta = [recipe.time_minutes ? `${recipe.time_minutes} min` : "", recipe.servings ? `${recipe.servings} porciones` : "", recipe.category || ""].filter(Boolean).join(" · ");
    return `<article class="recipe-card-wrap">
      <button class="recipe-card" type="button" data-detail-recipe="${recipe.id}">
        ${recipe.photo ? `<img class="recipe-thumb" src="${escapeHTML(recipe.photo)}" alt="">` : `<span class="recipe-icon">▤</span>`}
        <span class="recipe-text"><strong>${escapeHTML(recipe.name)}</strong>${meta ? `<small>${escapeHTML(meta)}</small>` : ""}</span>
      </button>
      <button class="recipe-delete" type="button" data-delete-recipe="${recipe.id}" aria-label="Eliminar ${escapeHTML(recipe.name)}">Eliminar</button>
    </article>`;
  }

  async function render() {
    if (!user) return;
    const [meals, recipes] = await Promise.all([all("meals"), all("recipes")]);
    const q = $("searchInput").value.trim().toLowerCase();

    $("mealView").hidden = activeView !== "meals";
    $("recipeView").hidden = activeView !== "recipes";
    $("filters").hidden = activeView !== "meals";
    $("clearSearch").hidden = !q;
    document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.view === activeView));
    document.querySelectorAll(".space").forEach(button => button.classList.toggle("active", button.dataset.space === activeSpace));
    document.querySelectorAll(".filter").forEach(button => button.classList.toggle("active", button.dataset.category === activeCategory));
    document.body.classList.toggle("milla", activeSpace === "milla");
    applyGridColumns();

    const filteredMeals = meals.filter(meal =>
      matchesSpace(meal, "meal") &&
      (activeCategory === "Todas" || meal.category === activeCategory) &&
      `${meal.name} ${meal.ingredients || ""}`.toLowerCase().includes(q)
    );
    $("mealGrid").innerHTML = filteredMeals.map(mealCard).join("");
    $("emptyMeals").hidden = filteredMeals.length > 0;

    const filteredRecipes = recipes.filter(recipe =>
      matchesSpace(recipe, "recipe") &&
      `${recipe.name} ${recipe.ingredients || ""} ${recipe.steps || ""}`.toLowerCase().includes(q)
    );
    $("recipeList").innerHTML = filteredRecipes.map(recipeCard).join("");
    $("emptyRecipes").hidden = filteredRecipes.length > 0;

  }

  function resetMealForm() {
    $("mealForm").reset();
    $("mealId").value = "";
    $("mealDialogTitle").textContent = "Agregar comida";
    selectedPhotos = [];
    $("photoPreview").innerHTML = "";
    setFormStatus("mealFormStatus");
  }

  function resetRecipeForm() {
    $("recipeForm").reset();
    $("recipeId").value = "";
    $("recipeDialogTitle").textContent = "Agregar receta";
    selectedRecipePhoto = null;
    $("recipePhotoPreview").innerHTML = "";
    setFormStatus("recipeFormStatus");
  }

  async function filesToPhotos(files) {
    const out = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      out.push({ name: file.name, data });
    }
    return out;
  }

  function previewMealPhotos() {
    $("photoPreview").innerHTML = selectedPhotos.map(photo => `<img src="${photo.data}" alt="${escapeHTML(photo.name)}">`).join("");
  }

  async function handleMealFiles(input) {
    try {
      const fresh = await filesToPhotos([...input.files].slice(0, 1));
      selectedPhotos = fresh;
      previewMealPhotos();
    } catch (error) {
      showError(error);
    }
    input.value = "";
  }

  async function handleRecipeFile(input) {
    try {
      const photos = await filesToPhotos([...input.files].slice(0, 1));
      selectedRecipePhoto = photos[0] || null;
      $("recipePhotoPreview").innerHTML = selectedRecipePhoto ? `<img src="${selectedRecipePhoto.data}" alt="Vista previa">` : "";
    } catch (error) {
      showError(error);
    }
    input.value = "";
  }

  function resetBulkFlow() { bulkPhotos = []; bulkGroups = []; bulkStep = 1; bulkSaveInFlight = false; setFormStatus("bulkStatus"); }

  function openBulkPicker() { resetBulkFlow(); $("bulkGalleryInput").click(); }

  async function handleBulkFiles(input) {
    try {
      const fresh = await filesToPhotos([...input.files]);
      if (!fresh.length) return;
      const additions = fresh.map(photo => ({ ...photo, id: uid(), cropX: 50, cropY: 50 }));
      if ($("bulkMealDialog").open && bulkPhotos.length) { bulkPhotos.push(...additions); if (!bulkGroups.length) bulkGroups = [{ id: uid(), photoIds: [], name: "", category: "Almuerzo / Cena", forMilla: false, coverId: null }]; bulkGroups[0].photoIds.push(...additions.map(photo => photo.id)); if (!bulkGroups[0].coverId) bulkGroups[0].coverId = additions[0].id; bulkStep = 1; renderBulkStep(); }
      else { bulkPhotos = additions; bulkGroups = [{ id: uid(), photoIds: bulkPhotos.map(photo => photo.id), name: "", category: "Almuerzo / Cena", forMilla: false, coverId: bulkPhotos[0].id }]; bulkStep = 1; renderBulkStep(); $("bulkMealDialog").showModal(); }
    } catch (error) { showError(error); }
    input.value = "";
  }

  function bulkPhoto(id) { return bulkPhotos.find(photo => photo.id === id); }
  function assignedPhotoIds() { return new Set(bulkGroups.flatMap(group => group.photoIds)); }
  function normalizeBulkGroups() { bulkGroups.forEach((group, index) => { if (!group.coverId || !group.photoIds.includes(group.coverId)) group.coverId = group.photoIds[0] || null; if (!group.name) group.name = `Comida ${index + 1}`; }); }

  function renderBulkStep() {
    const titles = { 1: "Fotos seleccionadas", 2: "¿Cómo querés organizarlas?", 3: "Agrupar en comidas", 4: "Completar las comidas" };
    $("bulkStepLabel").textContent = `Paso ${bulkStep} de 4`; $("bulkDialogTitle").textContent = titles[bulkStep]; $("bulkBack").hidden = bulkStep === 1; $("bulkNext").textContent = bulkStep === 4 ? "Guardar comidas" : "Continuar"; setFormStatus("bulkStatus");
    if (bulkStep === 1) renderBulkReview();
    if (bulkStep === 2) renderBulkChoice();
    if (bulkStep === 3) renderBulkGrouping();
    if (bulkStep === 4) renderBulkData();
  }

  function renderBulkReview() {
    $("bulkContent").innerHTML = `<p class="bulk-copy">${bulkPhotos.length} ${bulkPhotos.length === 1 ? "foto seleccionada" : "fotos seleccionadas"}.</p><div class="bulk-photo-grid">${bulkPhotos.map(photo => `<div class="bulk-photo"><img src="${photo.data}" alt="${escapeHTML(photo.name)}"><button type="button" data-remove-bulk="${photo.id}" aria-label="Quitar foto">×</button></div>`).join("")}</div><button type="button" id="bulkAddMore" class="secondary-button full-button bulk-add-more">＋ Agregar más fotos</button>`;
    $("bulkAddMore").onclick = () => $("bulkGalleryInput").click();
  }

  function renderBulkChoice() {
    $("bulkContent").innerHTML = `<div class="choice-grid"><button type="button" class="choice-card" data-bulk-choice="one"><strong>Todas son una misma comida</strong><span>Las ${bulkPhotos.length} fotos quedarán juntas.</span></button><button type="button" class="choice-card" data-bulk-choice="many"><strong>Son varias comidas</strong><span>Vas a decidir qué fotos corresponden a cada comida.</span></button></div>`;
    $("bulkNext").disabled = true;
  }

  function renderBulkGrouping() {
    normalizeBulkGroups(); const assigned = assignedPhotoIds(); const unassigned = bulkPhotos.filter(photo => !assigned.has(photo.id));
    $("bulkNext").disabled = unassigned.length > 0;
    $("bulkContent").innerHTML = `<p class="bulk-copy">Tocá una foto para moverla. Todas deben quedar dentro de una comida.</p>${bulkGroups.map((group, index) => `<section class="group-card"><div class="group-head"><strong>Comida ${index + 1}</strong><span>${group.photoIds.length} foto${group.photoIds.length === 1 ? "" : "s"}</span>${bulkGroups.length > 1 ? `<button type="button" data-delete-group="${group.id}">Eliminar grupo</button>` : ""}</div><div class="bulk-photo-grid compact">${group.photoIds.map(id => { const photo = bulkPhoto(id); return `<button type="button" class="bulk-photo selectable" data-move-photo="${id}" data-current-group="${group.id}"><img src="${photo.data}" alt="${escapeHTML(photo.name)}"><span>Mover</span></button>`; }).join("")}</div></section>`).join("")}<button type="button" id="addBulkGroup" class="secondary-button full-button">＋ Agregar otra comida</button>${unassigned.length ? `<p class="form-status">Quedan ${unassigned.length} fotos sin asignar.</p>` : ""}`;
    $("addBulkGroup").onclick = () => { bulkGroups.push({ id: uid(), photoIds: [], name: "", category: "Almuerzo / Cena", forMilla: false, coverId: null }); renderBulkGrouping(); };
  }

  function renderBulkData() {
    bulkGroups = bulkGroups.filter(group => group.photoIds.length); normalizeBulkGroups(); $("bulkNext").disabled = false;
    $("bulkContent").innerHTML = `<div class="bulk-data-list">${bulkGroups.map((group, index) => `<section class="group-card data-card" data-data-group="${group.id}"><h3>Comida ${index + 1}</h3><label class="field">Nombre<input data-group-name="${group.id}" maxlength="120" required value="${escapeHTML(group.name.startsWith("Comida ") ? "" : group.name)}" placeholder="Ej. Tarta de pollo"></label><div class="cover-picker"><p>Elegí la portada</p><div class="bulk-photo-grid compact">${group.photoIds.map(id => { const photo = bulkPhoto(id); return `<button type="button" class="bulk-photo cover-option ${group.coverId === id ? "active" : ""}" data-cover-photo="${id}" data-cover-group="${group.id}"><img src="${photo.data}" alt=""><span>${group.coverId === id ? "Portada" : "Elegir"}</span></button>`; }).join("")}</div></div><label class="field">Categoría<select data-group-category="${group.id}"><option${group.category === "Desayuno / Merienda" ? " selected" : ""}>Desayuno / Merienda</option><option${group.category === "Almuerzo / Cena" ? " selected" : ""}>Almuerzo / Cena</option><option${group.category === "Snacks / Postres" ? " selected" : ""}>Snacks / Postres</option></select></label><label class="check-row"><input data-group-milla="${group.id}" type="checkbox"${group.forMilla ? " checked" : ""}><span>También para Millá ♡</span></label></section>`).join("")}</div>`;
  }

  function syncBulkData() {
    bulkGroups.forEach(group => { const name = document.querySelector(`[data-group-name="${group.id}"]`); const category = document.querySelector(`[data-group-category="${group.id}"]`); const milla = document.querySelector(`[data-group-milla="${group.id}"]`); if (name) group.name = name.value.trim(); if (category) group.category = category.value; if (milla) group.forMilla = milla.checked; });
  }

  async function saveBulkMeals() {
    syncBulkData(); const invalid = bulkGroups.find(group => !group.name.trim()); if (invalid) { setFormStatus("bulkStatus", "Escribí un nombre para cada comida."); document.querySelector(`[data-group-name="${invalid.id}"]`)?.focus(); return; }
    if (bulkSaveInFlight) return; bulkSaveInFlight = true; $("bulkNext").disabled = true; $("bulkNext").textContent = "Guardando…"; setFormStatus("bulkStatus", "Guardando comidas y fotografías…", true);
    const createdMealIds = [];
    try {
      for (const group of bulkGroups) {
        const mealId = uid(); const uploaded = [];
        for (let index = 0; index < group.photoIds.length; index++) { const photo = bulkPhoto(group.photoIds[index]); const path = await uploadPhoto(photo.data, `meals/${mealId}/${index}-${photo.id}`); uploaded.push({ photo, path, position: index }); }
        const cover = uploaded.find(item => item.photo.id === group.coverId) || uploaded[0];
        const { error: mealError } = await sb.from("meals").insert({ id: mealId, user_id: user.id, name: group.name.trim(), ingredients: "", category: group.category, for_milla: Boolean(group.forMilla), favorite: false, photo_path: cover?.path || null }); if (mealError) { if (uploaded.length) await sb.storage.from("meal-photos").remove(uploaded.map(item => item.path)); throw mealError; }
        createdMealIds.push(mealId);
        if (uploaded.length) { const rows = uploaded.map(item => ({ meal_id: mealId, user_id: user.id, photo_path: item.path, position: item.position, is_cover: item.photo.id === group.coverId, crop_x: item.photo.cropX ?? 50, crop_y: item.photo.cropY ?? 50 })); const { error: photoError } = await sb.from("meal_photos").insert(rows); if (photoError) throw photoError; }
      }
      $("bulkMealDialog").close(); resetBulkFlow(); activeView = "meals"; notify(`${createdMealIds.length} ${createdMealIds.length === 1 ? "comida guardada" : "comidas guardadas"}`); await render();
    } catch (error) {
      for (const mealId of createdMealIds) { try { const extras = await mealPhotos(mealId); if (extras.length) await sb.storage.from("meal-photos").remove(extras.map(item => item.photo_path)); await sb.from("meals").delete().eq("id", mealId).eq("user_id", user.id); } catch (rollbackError) { console.error("Rollback incompleto:", rollbackError); } }
      setFormStatus("bulkStatus", `${readableError(error)} No se conservaron comidas incompletas; podés reintentar.`); showError(error);
    }
    finally { bulkSaveInFlight = false; $("bulkNext").disabled = false; $("bulkNext").textContent = bulkStep === 4 ? "Guardar comidas" : "Continuar"; }
  }

  async function openMealEditor(id = null) {
    resetMealForm();
    if (id) {
      const meal = (await all("meals")).find(item => item.id === id);
      if (!meal) return;
      $("mealId").value = meal.id;
      $("mealDialogTitle").textContent = "Editar comida";
      $("mealName").value = meal.name;
      $("mealIngredients").value = meal.ingredients || "";
      $("mealCategory").value = meal.category;
      $("mealForMilla").checked = Boolean(meal.forMilla);
      $("photoPreview").innerHTML = meal.photo ? `<img src="${meal.photo}" alt="Foto actual">` : "";
    }
    $("mealDialog").showModal();
  }

  async function openRecipeEditor(id = null) {
    resetRecipeForm();
    if (id) {
      const recipe = (await all("recipes")).find(item => item.id === id);
      if (!recipe) return;
      $("recipeId").value = recipe.id;
      $("recipeDialogTitle").textContent = "Editar receta";
      $("recipeName").value = recipe.name;
      $("recipeIngredients").value = recipe.ingredients || "";
      $("recipeSteps").value = recipe.steps || "";
      $("recipeTime").value = recipe.time_minutes ?? "";
      $("recipeServings").value = recipe.servings ?? "";
      $("recipeCategory").value = recipe.category || "";
      $("recipePhotoPreview").innerHTML = recipe.photo ? `<img src="${recipe.photo}" alt="Foto actual">` : "";
    }
    $("recipeDialog").showModal();
  }

  function detailSection(label, value) {
    if (!hasText(value) && value !== 0) return "";
    return `<section class="detail-section"><p class="detail-label">${escapeHTML(label)}</p><div class="detail-copy">${escapeHTML(value)}</div></section>`;
  }

  async function showDetail(type, id) {
    detailType = type;
    detailId = id;
    const table = type === "meal" ? "meals" : "recipes";
    const record = (await all(table)).find(item => item.id === id);
    if (!record) return;
    $("detailTitle").textContent = record.name;

    const photo = record.photo ? `<button type="button" class="detail-photo-button" data-photo-src="${escapeHTML(record.photo)}" data-photo-title="${escapeHTML(record.name)}"><img class="detail-photo" src="${escapeHTML(record.photo)}" alt="${escapeHTML(record.name)}"></button>` : "";

    if (type === "meal") {
      const extras = await mealPhotos(id);
      const gallery = extras.length ? `<div class="detail-gallery">${extras.map(item => `<button type="button" class="detail-gallery-button" data-photo-src="${escapeHTML(item.url || "")}" data-photo-title="${escapeHTML(record.name)}"><img src="${escapeHTML(item.url || "")}" alt="${escapeHTML(record.name)}" style="object-position:${Number(item.crop_x || 50)}% ${Number(item.crop_y || 50)}%"></button>`).join("")}</div>` : photo;
      $("detailContent").innerHTML = `${gallery}${detailSection("Ingredientes", record.ingredients)}${detailSection("Categoría", record.category)}`;
    } else {
      const meta = [record.time_minutes ? `${record.time_minutes} min` : "", record.servings ? `${record.servings} porciones` : "", record.category || ""].filter(Boolean);
      $("detailContent").innerHTML = `${photo}${meta.length ? `<div class="recipe-meta">${meta.map(item => `<span>${escapeHTML(item)}</span>`).join("")}</div>` : ""}${detailSection("Ingredientes", record.ingredients)}${detailSection("Preparación", record.steps)}`;
    }
    $("detailDialog").showModal();
  }

  function openLightbox(src, title = "") {
    $("lightboxImage").src = src;
    $("lightboxImage").alt = title || "Foto ampliada";
    $("photoLightbox").hidden = false;
    document.body.classList.add("lightbox-open");
    $("lightboxClose").focus();
  }

  function closeLightbox() {
    $("photoLightbox").hidden = true;
    document.body.classList.remove("lightbox-open");
  }

  function setLoggedIn(session) {
    user = session?.user || null;
    $("authGate").hidden = Boolean(user);
    $("mainApp").hidden = !user;
    if (user) render().catch(showError);
  }

  async function signInWithPasswordOnly() {
    const password = $("authPassword").value;
    if (!password || password.length < 6) {
      notify("Ingresá tu contraseña.");
      return;
    }
    const button = $("signInButton");
    button.disabled = true;
    button.textContent = "Entrando…";
    try {
      const tokens = await authHelper("login", password);
      const { data, error } = await sb.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
      if (error) throw error;
      $("authPassword").value = "";
      setLoggedIn(data.session);
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
      button.textContent = "Entrar";
    }
  }

  async function requestPasswordReset() {
    const button = $("forgotPasswordButton");
    button.disabled = true;
    try {
      await authHelper("reset");
      notify("Te mandamos un correo para cambiar la contraseña.");
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  }

  function bindPhotoOpen(container) {
    container.addEventListener("click", event => {
      const target = event.target.closest("[data-photo-src]");
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      openLightbox(target.dataset.photoSrc, target.dataset.photoTitle || "");
    });
  }

  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  $("quickAdd").onclick = $("addMealFooter").onclick = openBulkPicker;
  $("bulkGalleryInput").addEventListener("change", event => handleBulkFiles(event.target));
  $("bulkClose").onclick = () => { if (!bulkSaveInFlight) $("bulkMealDialog").close(); };
  $("addRecipeFooter").onclick = () => openRecipeEditor().catch(showError);
  $("galleryInput").addEventListener("change", event => handleMealFiles(event.target));
  $("cameraInput").addEventListener("change", event => handleMealFiles(event.target));
  $("recipeGalleryInput").addEventListener("change", event => handleRecipeFile(event.target));
  $("recipeCameraInput").addEventListener("change", event => handleRecipeFile(event.target));
  $("searchInput").addEventListener("input", () => render().catch(showError));
  $("clearSearch").onclick = () => { $("searchInput").value = ""; render().catch(showError); };
  document.querySelectorAll(".space").forEach(button => button.onclick = () => { activeSpace = button.dataset.space; render().catch(showError); });
  document.querySelectorAll(".tab").forEach(button => button.onclick = () => { activeView = button.dataset.view; render().catch(showError); });
  document.querySelectorAll(".filter").forEach(button => button.onclick = () => { activeCategory = button.dataset.category; render().catch(showError); });
  document.querySelectorAll("[data-grid-columns]").forEach(button => button.onclick = () => setGridColumns(button.dataset.gridColumns));
  applyGridColumns();

  bindPhotoOpen($("mealGrid"));
  bindPhotoOpen($("detailContent"));

  function updateMealSelectionUI() {
    const count = selectedMealIds.size;
    $("mealSelectionBar").hidden = !mealSelectionMode;
    $("selectionCount").textContent = count === 1 ? "1 seleccionada" : `${count} seleccionadas`;
    $("selectionEdit").disabled = count !== 1;
  }

  function exitMealSelection() { mealSelectionMode = false; selectedMealIds.clear(); updateMealSelectionUI(); render().catch(showError); }

  function openDeleteMealsDialog(ids) {
    pendingDeleteMealIds = [...new Set(ids.filter(Boolean))];
    const count = pendingDeleteMealIds.length; if (!count) return;
    $("deleteSelectionTitle").textContent = count === 1 ? "¿Eliminar esta comida?" : `¿Eliminar ${count} comidas?`;
    $("deleteSelectionText").textContent = count === 1 ? "Se eliminará la comida y sus fotografías. Esta acción no se puede deshacer." : `Se eliminarán las ${count} comidas seleccionadas y sus fotografías. Esta acción no se puede deshacer.`;
    $("deleteSelectionDialog").showModal();
  }

  let mealPressStartX = 0;
  let mealPressStartY = 0;
  const cancelMealPress = () => clearTimeout(mealPressTimer);
  $("mealGrid").addEventListener("pointerdown", event => {
    if (event.target.closest(".meal-action")) return;
    const card = event.target.closest("[data-meal-card]"); if (!card || mealSelectionMode) return;
    mealPressStartX = event.clientX; mealPressStartY = event.clientY;
    cancelMealPress();
    mealPressTimer = setTimeout(() => { suppressMealClick = true; mealSelectionMode = true; selectedMealIds.add(card.dataset.mealCard); updateMealSelectionUI(); render().catch(showError); if (navigator.vibrate) navigator.vibrate(20); }, 500);
  });
  $("mealGrid").addEventListener("pointermove", event => { if (Math.abs(event.clientX - mealPressStartX) > 10 || Math.abs(event.clientY - mealPressStartY) > 10) cancelMealPress(); });
  ["pointerup","pointercancel","pointerleave"].forEach(type => $("mealGrid").addEventListener(type, cancelMealPress));

  $("mealGrid").addEventListener("click", async event => {
    try {
      const action = event.target.closest(".meal-action");
      if (action) {
        event.stopPropagation();
        const edit = action.closest("[data-edit-meal]"); if (edit) return await openMealEditor(edit.dataset.editMeal);
        const remove = action.closest("[data-delete-meal]"); if (remove) return openDeleteMealsDialog([remove.dataset.deleteMeal]);
        const milla = action.closest("[data-milla-meal]");
        if (milla) { const meal = (await all("meals")).find(item => item.id === milla.dataset.millaMeal); if (meal) { const { error } = await sb.from("meals").update({ for_milla: !meal.forMilla }).eq("id", meal.id); if (error) throw error; await render(); } return; }
      }
      const card = event.target.closest("[data-meal-card]"); if (!card) return;
      if (suppressMealClick) { suppressMealClick = false; return; }
      const id = card.dataset.mealCard;
      if (mealSelectionMode) { selectedMealIds.has(id) ? selectedMealIds.delete(id) : selectedMealIds.add(id); if (!selectedMealIds.size) mealSelectionMode = false; updateMealSelectionUI(); return await render(); }
      await showDetail("meal", id);
    } catch (error) { showError(error); }
  });

  $("selectionCancel").onclick = exitMealSelection;
  $("selectionEdit").onclick = async () => { const id = [...selectedMealIds][0]; if (!id || selectedMealIds.size !== 1) return; mealSelectionMode = false; selectedMealIds.clear(); updateMealSelectionUI(); await openMealEditor(id); };
  $("selectionMilla").onclick = async () => { try { const meals = await all("meals"); const chosen = meals.filter(meal => selectedMealIds.has(meal.id)); const mark = !chosen.every(meal => meal.forMilla); for (const meal of chosen) { const { error } = await sb.from("meals").update({ for_milla: mark }).eq("id", meal.id); if (error) throw error; } notify(mark ? "Marcadas para Millá" : "Quitadas de Millá"); exitMealSelection(); } catch (error) { showError(error); } };
  $("selectionDelete").onclick = () => openDeleteMealsDialog([...selectedMealIds]);
  $("cancelSelectionDelete").onclick = () => { pendingDeleteMealIds = []; $("deleteSelectionDialog").close(); };
  $("confirmSelectionDelete").onclick = async () => { const button = $("confirmSelectionDelete"); button.disabled = true; try { const ids = [...pendingDeleteMealIds]; for (const id of ids) await deleteItem("meals", id); pendingDeleteMealIds = []; $("deleteSelectionDialog").close(); notify(ids.length === 1 ? "Comida eliminada" : `${ids.length} comidas eliminadas`); if (mealSelectionMode) exitMealSelection(); else await render(); } catch (error) { showError(error); } finally { button.disabled = false; } };

  $("bulkContent").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove-bulk]"); if (remove) { const id = remove.dataset.removeBulk; bulkPhotos = bulkPhotos.filter(photo => photo.id !== id); bulkGroups.forEach(group => group.photoIds = group.photoIds.filter(photoId => photoId !== id)); if (!bulkPhotos.length) { $("bulkMealDialog").close(); return; } renderBulkReview(); return; }
    const choice = event.target.closest("[data-bulk-choice]"); if (choice) { if (choice.dataset.bulkChoice === "one") { bulkGroups = [{ id: uid(), photoIds: bulkPhotos.map(photo => photo.id), name: "", category: "Almuerzo / Cena", forMilla: false, coverId: bulkPhotos[0].id }]; bulkStep = 4; renderBulkStep(); } else { bulkGroups = bulkPhotos.map((photo, index) => ({ id: uid(), photoIds: [photo.id], name: "", category: "Almuerzo / Cena", forMilla: false, coverId: photo.id })); bulkStep = 3; renderBulkStep(); } return; }
    const del = event.target.closest("[data-delete-group]"); if (del) { const group = bulkGroups.find(item => item.id === del.dataset.deleteGroup); const target = bulkGroups.find(item => item.id !== del.dataset.deleteGroup); if (group && target) target.photoIds.push(...group.photoIds); bulkGroups = bulkGroups.filter(item => item.id !== del.dataset.deleteGroup); renderBulkGrouping(); return; }
    const move = event.target.closest("[data-move-photo]"); if (move) { const destinations = bulkGroups.filter(group => group.id !== move.dataset.currentGroup); if (!destinations.length) return notify("Creá otra comida antes de mover la foto."); const labels = destinations.map((group, index) => `${index + 1}: Comida ${bulkGroups.indexOf(group) + 1}`).join("\n"); const chosen = Number(prompt(`Mover a:\n${labels}\n\nEscribí el número:`)); const target = destinations[chosen - 1]; if (!target) return; bulkGroups.find(group => group.id === move.dataset.currentGroup).photoIds = bulkGroups.find(group => group.id === move.dataset.currentGroup).photoIds.filter(id => id !== move.dataset.movePhoto); target.photoIds.push(move.dataset.movePhoto); normalizeBulkGroups(); renderBulkGrouping(); return; }
    const cover = event.target.closest("[data-cover-photo]"); if (cover) { syncBulkData(); const group = bulkGroups.find(item => item.id === cover.dataset.coverGroup); if (group) group.coverId = cover.dataset.coverPhoto; renderBulkData(); return; }
  });
  $("bulkContent").addEventListener("input", event => { const x = event.target.closest("[data-crop-x]"); const y = event.target.closest("[data-crop-y]"); if (x) { const group = bulkGroups.find(item => item.id === x.dataset.cropX); const photo = group && bulkPhoto(group.coverId); if (photo) photo.cropX = Number(x.value); } if (y) { const group = bulkGroups.find(item => item.id === y.dataset.cropY); const photo = group && bulkPhoto(group.coverId); if (photo) photo.cropY = Number(y.value); } });
  $("bulkBack").onclick = () => { if (bulkStep > 1) { if (bulkStep === 4) syncBulkData(); bulkStep--; renderBulkStep(); } };
  $("bulkNext").onclick = async () => { if (bulkStep === 1) { if (!bulkPhotos.length) return; bulkStep = 2; renderBulkStep(); return; } if (bulkStep === 2) return; if (bulkStep === 3) { if (assignedPhotoIds().size !== bulkPhotos.length) return setFormStatus("bulkStatus", "Todas las fotos deben estar asignadas."); bulkStep = 4; renderBulkStep(); return; } if (bulkStep === 4) await saveBulkMeals(); };

  $("recipeList").addEventListener("click", async event => {
    try {
      const edit = event.target.closest("[data-edit-recipe]");
      if (edit) return await openRecipeEditor(edit.dataset.editRecipe);
      const remove = event.target.closest("[data-delete-recipe]");
      if (remove) {
        if (!confirm("¿Eliminar esta receta?")) return;
        await deleteItem("recipes", remove.dataset.deleteRecipe);
        notify("Receta eliminada");
        return await render();
      }
      const detail = event.target.closest("[data-detail-recipe]");
      if (detail) await showDetail("recipe", detail.dataset.detailRecipe);
    } catch (error) {
      showError(error);
    }
  });

  $("mealForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (mealSaveInFlight) return;
    const id = $("mealId").value;
    const name = $("mealName").value.trim();
    if (!name) {
      setFormStatus("mealFormStatus", "Escribí un nombre para la comida.");
      $("mealName").focus();
      return;
    }

    const button = $("mealSaveButton");
    mealSaveInFlight = true;
    button.disabled = true;
    button.textContent = "Guardando…";
    setFormStatus("mealFormStatus", "Guardando…", true);

    try {
      const old = id ? (await all("meals")).find(meal => meal.id === id) : null;
      const base = {
        id: id || uid(),
        name,
        ingredients: $("mealIngredients").value.trim(),
        category: $("mealCategory").value,
        forMilla: $("mealForMilla").checked,
        favorite: Boolean(old?.favorite),
        photo_path: old?.photo_path || null,
        isEditing: Boolean(id),
      };
      base.photoData = selectedPhotos.length ? selectedPhotos[0].data : null;
      await saveMeal(base);
      setFormStatus("mealFormStatus", "Comida guardada.", true);
      closeDialogs();
      activeView = "meals";
      notify("Comida guardada");
      await render();
    } catch (error) {
      const message = readableError(error);
      setFormStatus("mealFormStatus", message);
      showError(error);
    } finally {
      mealSaveInFlight = false;
      button.disabled = false;
      button.textContent = "Guardar";
    }
  });

  $("recipeForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (recipeSaveInFlight) return;
    const id = $("recipeId").value;
    const name = $("recipeName").value.trim();
    if (!name) {
      setFormStatus("recipeFormStatus", "Escribí un nombre para la receta.");
      $("recipeName").focus();
      return;
    }

    const button = $("recipeSaveButton");
    recipeSaveInFlight = true;
    button.disabled = true;
    button.textContent = "Guardando…";
    setFormStatus("recipeFormStatus", "Guardando…", true);

    try {
      const old = id ? (await all("recipes")).find(recipe => recipe.id === id) : null;
      await saveRecipe({
        id: id || uid(),
        name,
        ingredients: $("recipeIngredients").value.trim(),
        steps: $("recipeSteps").value.trim(),
        timeMinutes: $("recipeTime").value ? Number($("recipeTime").value) : null,
        servings: $("recipeServings").value ? Number($("recipeServings").value) : null,
        category: $("recipeCategory").value || null,
        favorite: Boolean(old?.favorite),
        photo_path: old?.photo_path || null,
        photoData: selectedRecipePhoto?.data || null,
        isEditing: Boolean(id),
      });
      setFormStatus("recipeFormStatus", "Receta guardada.", true);
      closeDialogs();
      activeView = "recipes";
      notify("Receta guardada");
      await render();
    } catch (error) {
      const message = readableError(error);
      setFormStatus("recipeFormStatus", message);
      showError(error);
    } finally {
      recipeSaveInFlight = false;
      button.disabled = false;
      button.textContent = "Guardar";
    }
  });

  $("editDetail").onclick = async () => {
    const type = detailType;
    const id = detailId;
    closeDialogs();
    try {
      if (type === "meal") await openMealEditor(id);
      else await openRecipeEditor(id);
    } catch (error) {
      showError(error);
    }
  };

  $("deleteDetail").onclick = async () => {
    if (!detailId || !confirm("¿Eliminar este elemento?")) return;
    try {
      await deleteItem(detailType === "meal" ? "meals" : "recipes", detailId);
      closeDialogs();
      notify("Eliminado");
      await render();
    } catch (error) {
      showError(error);
    }
  };

  $("authForm").addEventListener("submit", event => { event.preventDefault(); signInWithPasswordOnly(); });
  $("forgotPasswordButton").onclick = requestPasswordReset;
  $("signOutButton").onclick = async () => {
    if (!confirm("¿Cerrar sesión?")) return;
    const { error } = await sb.auth.signOut();
    if (error) return showError(error);
    user = null;
    $("mainApp").hidden = true;
    $("authGate").hidden = false;
  };

  $("recoveryForm").addEventListener("submit", async event => {
    event.preventDefault();
    const password = $("newPassword").value;
    const confirmPassword = $("confirmPassword").value;
    if (password !== confirmPassword) return notify("Las contraseñas no coinciden.");
    try {
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
      $("recoveryDialog").close();
      $("recoveryForm").reset();
      notify("Contraseña actualizada.");
    } catch (error) {
      showError(error);
    }
  });

  $("lightboxClose").onclick = closeLightbox;
  $("photoLightbox").addEventListener("click", event => { if (event.target === $("photoLightbox")) closeLightbox(); });
  document.addEventListener("keydown", event => {
    if ($("photoLightbox").hidden) return;
    if (event.key === "Escape") closeLightbox();
  });

  async function init() {
    if (!configured) {
      $("authMessage").textContent = "Falta conectar Supabase en config.js.";
      return;
    }
    if (!window.supabase?.createClient) {
      $("authMessage").textContent = "No se pudo cargar Supabase. Revisá tu conexión.";
      return;
    }

    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setTimeout(() => $("recoveryDialog").showModal(), 0);
      setLoggedIn(session);
    });

    try {
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      setLoggedIn(data.session);
    } catch (error) {
      showError(error);
    }

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error), { once: true });
    }
  }

  init();
})();
