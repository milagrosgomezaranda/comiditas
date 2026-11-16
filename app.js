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
        ${meal.photo ? `<button type="button" class="photo-open" data-original-meal="${meal.id}" data-photo-src="${escapeHTML(meal.photo)}" data-photo-title="${escapeHTML(meal.name)}" aria-label="Ver foto de ${escapeHTML(meal.name)}"><img class="meal-photo" src="${escapeHTML(meal.photo)}" alt="${escapeHTML(meal.name)}"></button>` : `<div class="meal-photo photo-placeholder">Sin foto</div>`}
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

  async function createGalleryThumbnail(dataUrl) {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("No se pudo preparar la miniatura."));
      img.src = dataUrl;
    });
    const width = 1200;
    const height = 900;
    const sourceRatio = image.naturalWidth / image.naturalHeight;
    const targetRatio = width / height;
    let sx = 0, sy = 0, sw = image.naturalWidth, sh = image.naturalHeight;
    if (sourceRatio > targetRatio) {
      sw = image.naturalHeight * targetRatio;
      sx = (image.naturalWidth - sw) / 2;
    } else {
      sh = image.naturalWidth / targetRatio;
      sy = (image.naturalHeight - sh) / 2;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#f7f3ea";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.86);
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
      const fresh = await filesToPhotos([...input.files]); input.value = ""; if (!fresh.length) return;
      bulkPhotos = fresh.map(photo => ({ ...photo, id: uid() }));
      bulkGroups = bulkPhotos.map(photo => ({ id: uid(), photoIds: [photo.id], name: "", category: "", forMilla: false, coverId: photo.id }));
      renderQuickMeals(); $("bulkMealDialog").showModal();
    } catch (error) { showError(error); }
  }

  function bulkPhoto(id) { return bulkPhotos.find(photo => photo.id === id); }

  function renderQuickMeals() {
    $("bulkStepLabel").textContent = `${bulkPhotos.length} ${bulkPhotos.length === 1 ? "comida" : "comidas"}`;
    $("bulkDialogTitle").textContent = "Título y categoría";
    $("bulkBack").hidden = true; $("bulkNext").textContent = bulkPhotos.length === 1 ? "Guardar comida" : `Guardar ${bulkPhotos.length} comidas`; $("bulkNext").disabled = false; setFormStatus("bulkStatus");
    const categories = ["Desayuno / Merienda", "Almuerzo / Cena", "Snacks / Postres"];
    $("bulkContent").innerHTML = `<div class="quick-meal-list">${bulkGroups.map((group, index) => { const photo = bulkPhoto(group.photoIds[0]); return `<section class="quick-meal-card" data-quick-group="${group.id}"><img src="${photo.data}" alt="Comida ${index + 1}"><div class="quick-meal-fields"><label class="field">Título<input data-group-name="${group.id}" maxlength="120" required placeholder="Ej. Carne salteada" value="${escapeHTML(group.name)}"></label><fieldset class="quick-category"><legend>Categoría</legend><div class="quick-category-options">${categories.map(category => `<label><input type="radio" name="category-${group.id}" data-group-category="${group.id}" value="${escapeHTML(category)}"${group.category === category ? " checked" : ""}><span>${escapeHTML(category)}</span></label>`).join("")}</div></fieldset><label class="quick-milla"><input data-group-milla="${group.id}" type="checkbox"${group.forMilla ? " checked" : ""}><span class="quick-heart" aria-hidden="true">♡</span><span>Para Millá</span></label></div><button type="button" class="quick-remove" data-remove-bulk="${photo.id}" aria-label="Quitar esta foto">×</button></section>`; }).join("")}</div>`;
  }

  function syncQuickMeals() {
    bulkGroups.forEach(group => { const name = document.querySelector(`[data-group-name="${group.id}"]`); const milla = document.querySelector(`[data-group-milla="${group.id}"]`); const category = document.querySelector(`[data-group-category="${group.id}"]:checked`) || document.querySelector(`[data-group-category-select="${group.id}"]`); if (name) group.name = name.value.trim(); if (milla) group.forMilla = milla.checked; if (category) group.category = category.value; });
  }

  async function saveBulkMeals() {
    syncQuickMeals(); const invalid = bulkGroups.find(group => !group.name.trim() || !group.category); if (invalid) { setFormStatus("bulkStatus", !invalid.name.trim() ? "Poné un título a cada comida." : "Elegí una categoría para cada comida."); (!invalid.name.trim() ? document.querySelector(`[data-group-name="${invalid.id}"]`) : document.querySelector(`[data-group-category="${invalid.id}"]`))?.focus(); return; }
    if (bulkSaveInFlight) return; bulkSaveInFlight = true; $("bulkNext").disabled = true; $("bulkNext").textContent = "Guardando…"; setFormStatus("bulkStatus", "Guardando…", true);
    const createdMealIds = [];
    try {
      for (const group of bulkGroups) {
        const mealId = uid(); const photo = bulkPhoto(group.photoIds[0]);
        const thumbnailData = await createGalleryThumbnail(photo.data);
        const originalPath = await uploadPhoto(photo.data, `meals/${mealId}/${photo.id}-original`);
        let thumbnailPath;
        try { thumbnailPath = await uploadPhoto(thumbnailData, `meals/${mealId}/${photo.id}-thumb`); } catch (error) { await sb.storage.from("meal-photos").remove([originalPath]); throw error; }
        const { error: mealError } = await sb.from("meals").insert({ id: mealId, user_id: user.id, name: group.name.trim(), ingredients: "", category: group.category, for_milla: Boolean(group.forMilla), favorite: false, photo_path: thumbnailPath }); if (mealError) { await sb.storage.from("meal-photos").remove([originalPath, thumbnailPath]); throw mealError; }
        createdMealIds.push(mealId);
        const { error: photoError } = await sb.from("meal_photos").insert({ meal_id: mealId, user_id: user.id, photo_path: originalPath, position: 0, is_cover: true, crop_x: 50, crop_y: 50 }); if (photoError) throw photoError;
      }
      $("bulkMealDialog").close(); resetBulkFlow(); activeView = "meals"; notify(`${createdMealIds.length} ${createdMealIds.length === 1 ? "comida guardada" : "comidas guardadas"}`); await render();
    } catch (error) {
      for (const mealId of createdMealIds) { try { const extras = await mealPhotos(mealId); if (extras.length) await sb.storage.from("meal-photos").remove(extras.map(item => item.photo_path)); await sb.from("meals").delete().eq("id", mealId).eq("user_id", user.id); } catch (rollbackError) { console.error("Rollback incompleto:", rollbackError); } }
      setFormStatus("bulkStatus", `${readableError(error)} Podés reintentar.`); showError(error);
    } finally { bulkSaveInFlight = false; $("bulkNext").disabled = false; $("bulkNext").textContent = bulkPhotos.length === 1 ? "Guardar comida" : `Guardar ${bulkPhotos.length} comidas`; }
  }

  async function openBatchMealEditor(ids) {
    const meals = (await all("meals")).filter(meal => ids.includes(meal.id)); if (!meals.length) return;
    bulkPhotos = []; bulkGroups = meals.map(meal => ({ id: meal.id, existingId: meal.id, photoIds: [], name: meal.name, category: meal.category || "Almuerzo / Cena", forMilla: Boolean(meal.forMilla), existingPhoto: meal.photo }));
    $("bulkStepLabel").textContent = `${meals.length} seleccionadas`; $("bulkDialogTitle").textContent = "Editar comidas"; $("bulkBack").hidden = true; $("bulkNext").textContent = "Guardar cambios"; $("bulkNext").disabled = false; setFormStatus("bulkStatus");
    $("bulkContent").innerHTML = `<div class="quick-meal-list">${bulkGroups.map(group => `<section class="quick-meal-card" data-quick-group="${group.id}">${group.existingPhoto ? `<img src="${escapeHTML(group.existingPhoto)}" alt="${escapeHTML(group.name)}">` : `<div class="quick-photo-placeholder">Sin foto</div>`}<div class="quick-meal-fields"><label class="field">Título<input data-group-name="${group.id}" maxlength="120" required value="${escapeHTML(group.name)}"></label><label class="field">Categoría<select data-group-category-select="${group.id}"><option${group.category === "Desayuno / Merienda" ? " selected" : ""}>Desayuno / Merienda</option><option${group.category === "Almuerzo / Cena" ? " selected" : ""}>Almuerzo / Cena</option><option${group.category === "Snacks / Postres" ? " selected" : ""}>Snacks / Postres</option></select></label><label class="quick-milla"><input data-group-milla="${group.id}" type="checkbox"${group.forMilla ? " checked" : ""}><span class="quick-heart">♡</span><span>Para Millá</span></label></div></section>`).join("")}</div>`;
    $("bulkMealDialog").dataset.mode = "edit"; $("bulkMealDialog").showModal();
  }

  async function saveBatchMealEdits() {
    syncQuickMeals(); const invalid = bulkGroups.find(group => !group.name.trim()); if (invalid) { setFormStatus("bulkStatus", "Poné un título a cada comida."); return; }
    const button = $("bulkNext"); button.disabled = true; button.textContent = "Guardando…";
    try { for (const group of bulkGroups) { const { error } = await sb.from("meals").update({ name: group.name.trim(), category: group.category, for_milla: Boolean(group.forMilla) }).eq("id", group.existingId).eq("user_id", user.id); if (error) throw error; } $("bulkMealDialog").close(); delete $("bulkMealDialog").dataset.mode; notify("Cambios guardados"); exitMealSelection(); } catch (error) { showError(error); } finally { button.disabled = false; button.textContent = "Guardar cambios"; }
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
    container.addEventListener("click", async event => {
      const target = event.target.closest("[data-photo-src]");
      if (!target) return;
      if (container === $("mealGrid") && (mealSelectionMode || suppressMealClick)) return;
      event.preventDefault();
      event.stopPropagation();
      let source = target.dataset.photoSrc;
      if (target.dataset.originalMeal) {
        try { const originals = await mealPhotos(target.dataset.originalMeal); if (originals[0]?.url) source = originals[0].url; } catch (error) { console.warn("No se pudo abrir el original:", error); }
      }
      openLightbox(source, "");
    });
  }

  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  $("quickAdd").onclick = $("addMealFooter").onclick = openBulkPicker;
  $("bulkGalleryInput").addEventListener("change", event => handleBulkFiles(event.target));
  $("bulkClose").onclick = () => { if (!bulkSaveInFlight) { $("bulkMealDialog").close(); delete $("bulkMealDialog").dataset.mode; resetBulkFlow(); } };
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
    $("selectionEdit").disabled = count < 1;
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
      return;
    } catch (error) { showError(error); }
  });

  $("selectionCancel").onclick = exitMealSelection;
  $("selectionEdit").onclick = async () => { const ids = [...selectedMealIds]; if (!ids.length) return; if (ids.length === 1) { mealSelectionMode = false; selectedMealIds.clear(); updateMealSelectionUI(); return await openMealEditor(ids[0]); } await openBatchMealEditor(ids); };
  $("selectionMilla").onclick = async () => { try { const meals = await all("meals"); const chosen = meals.filter(meal => selectedMealIds.has(meal.id)); const mark = !chosen.every(meal => meal.forMilla); for (const meal of chosen) { const { error } = await sb.from("meals").update({ for_milla: mark }).eq("id", meal.id); if (error) throw error; } notify(mark ? "Marcadas para Millá" : "Quitadas de Millá"); exitMealSelection(); } catch (error) { showError(error); } };
  $("selectionDelete").onclick = () => openDeleteMealsDialog([...selectedMealIds]);
  $("cancelSelectionDelete").onclick = () => { pendingDeleteMealIds = []; $("deleteSelectionDialog").close(); };
  $("confirmSelectionDelete").onclick = async () => { const button = $("confirmSelectionDelete"); button.disabled = true; try { const ids = [...pendingDeleteMealIds]; for (const id of ids) await deleteItem("meals", id); pendingDeleteMealIds = []; $("deleteSelectionDialog").close(); notify(ids.length === 1 ? "Comida eliminada" : `${ids.length} comidas eliminadas`); if (mealSelectionMode) exitMealSelection(); else await render(); } catch (error) { showError(error); } finally { button.disabled = false; } };

  $("bulkContent").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove-bulk]"); if (!remove) return;
    syncQuickMeals(); const id = remove.dataset.removeBulk; const photo = bulkPhotos.find(item => item.id === id); bulkPhotos = bulkPhotos.filter(item => item.id !== id); if (photo) bulkGroups = bulkGroups.filter(group => !group.photoIds.includes(id)); if (!bulkPhotos.length) { $("bulkMealDialog").close(); resetBulkFlow(); return; } renderQuickMeals();
  });
  $("bulkBack").onclick = () => {};
  $("bulkNext").onclick = async () => { if ($("bulkMealDialog").dataset.mode === "edit") await saveBatchMealEdits(); else await saveBulkMeals(); };

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
