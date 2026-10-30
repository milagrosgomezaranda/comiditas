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
  let selectedPhotos = [];
  let selectedRecipePhoto = null;
  let detailType = null;
  let detailId = null;
  let lightboxItems = [];
  let lightboxIndex = 0;
  let toastTimer = null;

  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const hasText = value => typeof value === "string" && value.trim().length > 0;

  function notify(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  function showError(error) {
    console.error(error);
    const message = error?.message || "Ocurrió un error. Revisá la conexión e intentá de nuevo.";
    if (/column .* does not exist|schema cache|favorite|time_minutes|servings|photo_path/i.test(message)) {
      notify("Falta aplicar la migración v2 de Supabase.");
      return;
    }
    notify(message);
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
    const { error } = await sb.from("meals").upsert(payload);
    if (error) throw error;
  }

  async function saveRecipe(recipe) {
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
    const { error } = await sb.from("recipes").upsert(payload);
    if (error) throw error;
  }

  async function deleteItem(table, id) {
    const { data } = await sb.from(table).select("photo_path").eq("id", id).maybeSingle();
    if (data?.photo_path) await sb.storage.from("meal-photos").remove([data.photo_path]);
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw error;
  }

  function matchesSpace(record, type) {
    if (activeSpace === "favorites") return Boolean(record.favorite);
    if (activeSpace === "milla") return type === "meal" && Boolean(record.forMilla);
    return true;
  }

  function mealCard(meal) {
    return `<article class="meal-card">
      ${meal.photo
        ? `<button class="photo-open" type="button" data-photo-src="${escapeHTML(meal.photo)}" data-photo-title="${escapeHTML(meal.name)}"><img class="meal-photo" src="${escapeHTML(meal.photo)}" alt="${escapeHTML(meal.name)}"></button>`
        : `<button class="meal-photo photo-placeholder" type="button" data-detail-meal="${meal.id}" aria-label="Ver ${escapeHTML(meal.name)}">♡</button>`}
      <div class="meal-title-row">
        <button class="meal-title" type="button" data-detail-meal="${meal.id}">${escapeHTML(meal.name)}</button>
        <button class="mini-action ${meal.favorite ? "marked-gold" : ""}" type="button" data-favorite-meal="${meal.id}" aria-label="${meal.favorite ? "Quitar de favoritas" : "Guardar en favoritas"}">★</button>
        <button class="heart ${meal.forMilla ? "marked" : ""}" type="button" data-heart="${meal.id}" aria-label="${meal.forMilla ? "Quitar de Millá" : "Marcar para Millá"}">${meal.forMilla ? "♥" : "♡"}</button>
      </div>
      <div class="meal-category">${escapeHTML(meal.category)}</div>
    </article>`;
  }

  function recipeCard(recipe) {
    const meta = [recipe.time_minutes ? `${recipe.time_minutes} min` : "", recipe.servings ? `${recipe.servings} porciones` : "", recipe.category || ""].filter(Boolean).join(" · ");
    return `<article class="recipe-card-wrap">
      <button class="recipe-card" type="button" data-detail-recipe="${recipe.id}">
        ${recipe.photo ? `<img class="recipe-thumb" src="${escapeHTML(recipe.photo)}" alt="">` : `<span class="recipe-icon">▤</span>`}
        <span class="recipe-text"><strong>${escapeHTML(recipe.name)}</strong>${meta ? `<small>${escapeHTML(meta)}</small>` : ""}</span>
      </button>
      <button class="recipe-favorite ${recipe.favorite ? "marked-gold" : ""}" type="button" data-favorite-recipe="${recipe.id}" aria-label="${recipe.favorite ? "Quitar de favoritas" : "Guardar en favoritas"}">★</button>
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

    lightboxItems = (activeView === "meals" ? filteredMeals : filteredRecipes)
      .filter(item => item.photo)
      .map(item => ({ src: item.photo, title: item.name }));
  }

  function resetMealForm() {
    $("mealForm").reset();
    $("mealId").value = "";
    $("mealDialogTitle").textContent = "Agregar comida";
    selectedPhotos = [];
    $("photoPreview").innerHTML = "";
  }

  function resetRecipeForm() {
    $("recipeForm").reset();
    $("recipeId").value = "";
    $("recipeDialogTitle").textContent = "Agregar receta";
    selectedRecipePhoto = null;
    $("recipePhotoPreview").innerHTML = "";
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
      const fresh = await filesToPhotos([...input.files]);
      selectedPhotos.push(...fresh);
      previewMealPhotos();
      if (fresh.length === 1 && !$("mealName").value) $("mealName").value = fresh[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
      if (fresh.length > 1) notify(`${fresh.length} fotos seleccionadas`);
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
      $("mealFavorite").checked = Boolean(meal.favorite);
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
      $("recipeFavorite").checked = Boolean(recipe.favorite);
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
      $("detailContent").innerHTML = `${photo}${detailSection("Ingredientes", record.ingredients)}${detailSection("Categoría", record.category)}`;
    } else {
      const meta = [record.time_minutes ? `${record.time_minutes} min` : "", record.servings ? `${record.servings} porciones` : "", record.category || ""].filter(Boolean);
      $("detailContent").innerHTML = `${photo}${meta.length ? `<div class="recipe-meta">${meta.map(item => `<span>${escapeHTML(item)}</span>`).join("")}</div>` : ""}${detailSection("Ingredientes", record.ingredients)}${detailSection("Preparación", record.steps)}`;
    }
    $("detailDialog").showModal();
  }

  async function toggleFavorite(table, id) {
    const records = await all(table);
    const record = records.find(item => item.id === id);
    if (!record) return;
    const { error } = await sb.from(table).update({ favorite: !record.favorite }).eq("id", id);
    if (error) throw error;
    await render();
  }

  function openLightbox(src, title = "") {
    const existing = lightboxItems.findIndex(item => item.src === src);
    if (existing === -1) lightboxItems = [{ src, title }, ...lightboxItems];
    lightboxIndex = Math.max(0, lightboxItems.findIndex(item => item.src === src));
    updateLightbox();
    $("photoLightbox").hidden = false;
    document.body.classList.add("lightbox-open");
    $("lightboxClose").focus();
  }

  function updateLightbox() {
    const current = lightboxItems[lightboxIndex];
    if (!current) return;
    $("lightboxImage").src = current.src;
    $("lightboxImage").alt = current.title || "Foto ampliada";
    $("lightboxCaption").textContent = current.title || "";
    const multiple = lightboxItems.length > 1;
    $("lightboxPrev").hidden = !multiple;
    $("lightboxNext").hidden = !multiple;
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
  $("quickAdd").onclick = $("addMealFooter").onclick = () => openMealEditor().catch(showError);
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

  bindPhotoOpen($("mealGrid"));
  bindPhotoOpen($("detailContent"));

  $("mealGrid").addEventListener("click", async event => {
    try {
      const favorite = event.target.closest("[data-favorite-meal]");
      if (favorite) return await toggleFavorite("meals", favorite.dataset.favoriteMeal);
      const heart = event.target.closest("[data-heart]");
      if (heart) {
        const meal = (await all("meals")).find(item => item.id === heart.dataset.heart);
        if (meal) {
          const { error } = await sb.from("meals").update({ for_milla: !meal.forMilla }).eq("id", meal.id);
          if (error) throw error;
          await render();
        }
        return;
      }
      const detail = event.target.closest("[data-detail-meal]");
      if (detail) await showDetail("meal", detail.dataset.detailMeal);
    } catch (error) {
      showError(error);
    }
  });

  $("recipeList").addEventListener("click", async event => {
    try {
      const favorite = event.target.closest("[data-favorite-recipe]");
      if (favorite) return await toggleFavorite("recipes", favorite.dataset.favoriteRecipe);
      const detail = event.target.closest("[data-detail-recipe]");
      if (detail) await showDetail("recipe", detail.dataset.detailRecipe);
    } catch (error) {
      showError(error);
    }
  });

  $("mealForm").addEventListener("submit", async event => {
    event.preventDefault();
    const id = $("mealId").value;
    const name = $("mealName").value.trim();
    if (!name) return;
    try {
      const old = id ? (await all("meals")).find(meal => meal.id === id) : null;
      const base = {
        id: id || uid(),
        name,
        ingredients: $("mealIngredients").value.trim(),
        category: $("mealCategory").value,
        forMilla: $("mealForMilla").checked,
        favorite: $("mealFavorite").checked,
        photo_path: old?.photo_path || null,
      };
      if (id) {
        base.photoData = selectedPhotos.length ? selectedPhotos[0].data : null;
        await saveMeal(base);
      } else if (selectedPhotos.length) {
        for (let i = 0; i < selectedPhotos.length; i += 1) {
          await saveMeal({ ...base, id: uid(), name: selectedPhotos.length > 1 && i > 0 ? `${name} ${i + 1}` : name, photoData: selectedPhotos[i].data });
        }
      } else {
        await saveMeal(base);
      }
      closeDialogs();
      activeView = "meals";
      notify("Comida guardada");
      await render();
    } catch (error) {
      showError(error);
    }
  });

  $("recipeForm").addEventListener("submit", async event => {
    event.preventDefault();
    const id = $("recipeId").value;
    const name = $("recipeName").value.trim();
    if (!name) return;
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
        favorite: $("recipeFavorite").checked,
        photo_path: old?.photo_path || null,
        photoData: selectedRecipePhoto?.data || null,
      });
      closeDialogs();
      activeView = "recipes";
      notify("Receta guardada");
      await render();
    } catch (error) {
      showError(error);
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
  $("lightboxPrev").onclick = () => { lightboxIndex = (lightboxIndex - 1 + lightboxItems.length) % lightboxItems.length; updateLightbox(); };
  $("lightboxNext").onclick = () => { lightboxIndex = (lightboxIndex + 1) % lightboxItems.length; updateLightbox(); };
  $("photoLightbox").addEventListener("click", event => { if (event.target === $("photoLightbox")) closeLightbox(); });
  document.addEventListener("keydown", event => {
    if ($("photoLightbox").hidden) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft" && lightboxItems.length > 1) $("lightboxPrev").click();
    if (event.key === "ArrowRight" && lightboxItems.length > 1) $("lightboxNext").click();
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
