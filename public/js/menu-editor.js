'use strict';

/**
 * Shared Menu & Menu Item Editor used by both Admin (/manager/menus)
 * and Restaurant Partner Portal (/restaurant/menus).
 */
(function (global) {
  let cfg = {
    apiBase: '/manager/api',
    uploadEndpoint: null,
    getRestaurantId: () => null,
    notify: (title, msg) => console.log(title, msg),
    showLoading: () => {},
    hideLoading: () => {},
    onChanged: () => {},
  };

  let menus = [];
  let allCategories = new Set();
  let activeCategory = 'all';
  let deleteCallback = null;
  let currentCustomizationGroups = [];
  let wired = false;

  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  function getItemCategories(item) {
    if (!item) return ['General'];
    const parseList = (raw) => {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
          } catch (_) {}
        }
        return trimmed.split(',');
      }
      return [String(raw)];
    };

    const rawList = parseList(item.categories);
    const source = rawList.length ? rawList : parseList(item.category);
    const seen = new Set();
    const result = [];
    source.forEach((entry) => {
      const clean = String(entry || '').trim();
      if (!clean) return;
      const slug = clean.toLowerCase();
      if (seen.has(slug)) return;
      seen.add(slug);
      result.push(clean);
    });
    return result.length ? result : ['General'];
  }

  function openModalEl(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('active');
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModalEl(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('active');
    el.classList.remove('open');
    document.body.style.overflow = '';
  }

  function init(options) {
    cfg = { ...cfg, ...options };

    if (!wired) {
      wired = true;
      setupTagInputs();

      const confirmBtn = document.getElementById('confirmDeleteBtn');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          if (deleteCallback) deleteCallback();
        });
      }

      const searchInput = document.getElementById('menuSearchInput');
      if (searchInput) {
        searchInput.addEventListener('input', function (e) {
          const term = e.target.value.toLowerCase();
          document.querySelectorAll('.menu-item-card').forEach((card) => {
            const text = card.textContent.toLowerCase();
            card.style.display = text.includes(term) ? '' : 'none';
          });
        });
      }

      document.querySelectorAll('.modal-overlay').forEach((overlay) => {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModalEl(overlay.id);
        });
      });
    }

    const uploadWrap = document.getElementById('itemUploadWrap');
    if (uploadWrap) {
      uploadWrap.style.display = cfg.uploadEndpoint ? 'flex' : 'none';
    }
  }

  // ── Load & Render Menus ─────────────────────────────────────────────────────
  async function loadMenus() {
    const restaurantId = cfg.getRestaurantId();
    if (!restaurantId) return;
    try {
      cfg.showLoading();
      const res = await fetch(`${cfg.apiBase}/menus?restaurantId=${encodeURIComponent(restaurantId)}`, {
        credentials: 'same-origin',
      });
      const data = await res.json();

      if (data.success) {
        menus = data.menus || [];
        allCategories = new Set();
        menus.forEach((m) => {
          (m.items || []).forEach((i) => {
            getItemCategories(i).forEach((cat) => allCategories.add(cat));
          });
        });
        renderMenus();
        const catCard = document.getElementById('categoriesCard');
        if (catCard) catCard.style.display = 'block';
      } else {
        cfg.notify('Error', data.error || 'Failed to load menus', 'error');
      }
    } catch (err) {
      console.error('[MenuEditor.loadMenus]', err);
      cfg.notify('Error', 'Failed to load menus', 'error');
    } finally {
      cfg.hideLoading();
    }
  }

  function renderMenus() {
    const container = document.getElementById('menusContainer');
    if (!container) return;

    if (!menus.length) {
      container.innerHTML = `
        <div class="card">
          <div class="empty-state">
            <i class="fas fa-clipboard-list"></i>
            <h5>No Menus Yet</h5>
            <p>Create your first menu to start adding items.</p>
            <button type="button" class="btn btn-primary" style="margin-top:1rem;" onclick="openMenuModal()">
              <i class="fas fa-plus"></i> Create Menu
            </button>
          </div>
        </div>`;
      renderCategories();
      return;
    }

    container.innerHTML = menus.map((menu) => `
      <div class="card menu-container" data-menu-id="${escapeHtml(menu.id)}">
        <div class="card-header">
          <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
            <h3 class="card-title">${escapeHtml(menu.name)}</h3>
            ${menu.is_active !== false
              ? '<span class="badge" style="background:#22c55e;color:white;">Active</span>'
              : '<span class="badge" style="background:hsl(var(--muted-foreground));color:white;">Inactive</span>'}
          </div>
          <div class="menu-actions">
            <button type="button" class="btn btn-sm" onclick="openItemModal('${escapeHtml(menu.id)}')" title="Add Item">
              <i class="fas fa-plus"></i> Add Item
            </button>
            <button type="button" class="btn btn-sm" onclick="editMenu('${escapeHtml(menu.id)}')" title="Edit Menu">
              <i class="fas fa-edit"></i> Edit
            </button>
            <button type="button" class="btn btn-sm" onclick="confirmDeleteMenu('${escapeHtml(menu.id)}')" title="Delete Menu">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>
        <div class="card-body" style="padding:1.25rem 1.35rem;">
          ${menu.description ? `<p style="font-size:0.875rem;color:hsl(var(--muted-foreground));margin-bottom:0.85rem;">${escapeHtml(menu.description)}</p>` : ''}
          <div class="menu-items-grid">
            ${renderMenuItems(menu.items || [], menu.id)}
          </div>
        </div>
      </div>
    `).join('');

    renderCategories();
  }

  function renderMenuItems(items, menuId) {
    let filtered = items;
    if (activeCategory !== 'all') {
      const target = String(activeCategory).trim().toLowerCase();
      filtered = items.filter((i) =>
        getItemCategories(i).some((cat) => cat.toLowerCase() === target)
      );
    }

    if (!filtered.length) {
      return activeCategory === 'all'
        ? `<div class="empty-state" style="grid-column:1 / -1;padding:2rem;">
            <i class="fas fa-inbox" style="font-size:2rem;"></i>
            <p>No items in this menu yet</p>
            <button type="button" class="btn btn-sm btn-outline" style="margin-top:0.5rem;" onclick="openItemModal('${escapeHtml(menuId)}')">
              Add First Item
            </button>
           </div>`
        : `<div class="empty-state" style="grid-column:1 / -1;padding:2rem;">
            <p>No items in category "${escapeHtml(activeCategory)}"</p>
           </div>`;
    }

    return filtered.map((item) => {
      const itemCats = getItemCategories(item);
      itemCats.forEach((cat) => allCategories.add(cat));
      const hasDiscount = item.discounted_price && Number(item.discounted_price) < Number(item.price);
      const customGroups = Array.isArray(item.customizations)
        ? item.customizations
        : (() => { try { return JSON.parse(item.customizations || '[]'); } catch { return []; } })();
      const totalOptionChoices = customGroups.reduce((acc, g) => acc + (Array.isArray(g.options) ? g.options.length : 0), 0);
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : [];
      const tags = Array.isArray(item.tags) ? item.tags : [];

      return `
        <div class="menu-item-card ${item.is_available ? '' : 'unavailable'}">
          <div class="item-image">
            ${item.image_url
              ? `<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.name)}" onerror="this.parentElement.innerHTML='<i class=\\'fas fa-utensils\\'></i>'">`
              : '<i class="fas fa-utensils"></i>'}
          </div>
          <div class="item-header">
            <h6 class="item-name">${escapeHtml(item.name)}</h6>
            <div class="item-badges">
              ${item.is_veg ? '<span class="badge-veg"><i class="fas fa-leaf"></i> Veg</span>' : ''}
              ${item.is_popular ? '<span class="badge-popular"><i class="fas fa-fire"></i> Popular</span>' : ''}
            </div>
          </div>
          <div class="item-category">
            ${itemCats.map((cat) => `<span class="item-category-chip">${escapeHtml(cat)}</span>`).join('')}
          </div>
          <div class="item-description">${escapeHtml(item.description || '')}</div>
          <div class="item-meta">
            ${item.calories ? `<span><i class="fas fa-fire-alt"></i> ${item.calories} kcal</span>` : ''}
            ${item.preparation_time_minutes ? `<span><i class="fas fa-clock"></i> ${item.preparation_time_minutes} min</span>` : ''}
            ${customGroups.length ? `<span style="color:hsl(var(--primary));font-weight:600;"><i class="fas fa-sliders-h"></i> ${customGroups.length} option group${customGroups.length > 1 ? 's' : ''} (${totalOptionChoices} choices)</span>` : ''}
          </div>
          <div class="item-price-row">
            <div>
              <span class="price-current">R ${hasDiscount ? item.discounted_price : item.price}</span>
              ${hasDiscount ? `<span class="price-original">R ${item.price}</span>` : ''}
            </div>
            <span class="badge ${item.is_available ? 'badge-green' : 'badge-gray'}">
              ${item.is_available ? 'Available' : 'Unavailable'}
            </span>
          </div>
          <div class="item-actions">
            <button type="button" class="btn btn-outline btn-sm" onclick="editItem('${escapeHtml(item.id)}')">
              <i class="fas fa-edit"></i> Edit
            </button>
            <button type="button" class="btn btn-outline btn-sm"
              style="${item.is_available ? 'color:#92400e;border-color:#fcd34d;background:#fef3c7;' : 'color:#166534;border-color:#86efac;background:#dcfce7;'}"
              onclick="toggleItemAvailability('${escapeHtml(item.id)}', ${!item.is_available})">
              <i class="fas fa-${item.is_available ? 'eye-slash' : 'eye'}"></i>
              ${item.is_available ? 'Disable' : 'Enable'}
            </button>
            <button type="button" class="btn btn-outline btn-sm" style="color:#991b1b;border-color:#fca5a5;" onclick="confirmDeleteItem('${escapeHtml(item.id)}')">
              <i class="fas fa-trash"></i>
            </button>
          </div>
          ${ingredients.length || tags.length ? `
          <div class="nutrition-info">
            ${ingredients.slice(0, 3).map((ing) => `<span class="nutrition-badge">${escapeHtml(ing)}</span>`).join('')}
            ${ingredients.length > 3 ? `<span class="nutrition-badge">+${ingredients.length - 3} more</span>` : ''}
            ${tags.slice(0, 2).map((tag) => `<span class="nutrition-badge" style="background:#eff6ff;color:#1d4ed8;">#${escapeHtml(tag)}</span>`).join('')}
          </div>` : ''}
        </div>`;
    }).join('');
  }

  function renderCategories() {
    const container = document.getElementById('categoryFilter');
    const datalist = document.getElementById('categoryList');
    const sortedCategories = Array.from(allCategories).sort((a, b) => a.localeCompare(b));
    if (container) {
      let html = `<div class="category-pill ${activeCategory === 'all' ? 'active' : ''}" data-category="all">All Items</div>`;
      sortedCategories.forEach((cat) => {
        const isActive = activeCategory.toLowerCase() === cat.toLowerCase();
        html += `<div class="category-pill ${isActive ? 'active' : ''}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</div>`;
      });
      container.innerHTML = html;

      container.querySelectorAll('.category-pill').forEach((pill) => {
        pill.addEventListener('click', () => {
          activeCategory = pill.dataset.category;
          renderMenus();
        });
      });
    }
    if (datalist) {
      datalist.innerHTML = sortedCategories
        .map((cat) => `<option value="${escapeHtml(cat)}">`)
        .join('');
    }
    renderCategoryQuickPills();
  }

  function renderCategoryQuickPills() {
    const quickWrap = document.getElementById('categoryQuickPills');
    if (!quickWrap) return;
    const sortedCategories = Array.from(allCategories).sort((a, b) => a.localeCompare(b));
    if (!sortedCategories.length) {
      quickWrap.innerHTML = '';
      return;
    }
    const selectedSet = new Set(getTags('categoriesContainer').map((c) => c.toLowerCase()));
    quickWrap.innerHTML = `<span style="font-size:0.75rem;color:hsl(var(--muted-foreground));align-self:center;">Quick pick:</span>` +
      sortedCategories.map((cat) => {
        const selected = selectedSet.has(cat.toLowerCase());
        return `<button type="button" class="category-quick-pill ${selected ? 'selected' : ''}" data-cat="${escapeHtml(cat)}">${selected ? '✓ ' : '+ '}${escapeHtml(cat)}</button>`;
      }).join('');

    quickWrap.querySelectorAll('.category-quick-pill').forEach((btn) => {
      btn.addEventListener('click', () => toggleItemCategoryQuickPick(btn.dataset.cat));
    });
  }

  function toggleItemCategoryQuickPick(categoryName) {
    const container = document.getElementById('categoriesContainer');
    if (!container || !categoryName) return;
    const clean = categoryName.trim();
    const existingChip = Array.from(container.querySelectorAll('.tag-chip')).find(
      (chip) => getChipValue(chip).toLowerCase() === clean.toLowerCase()
    );
    if (existingChip) {
      existingChip.remove();
    } else {
      addTagChip(container, clean, { dedupe: true, onChange: renderCategoryQuickPills });
    }
    renderCategoryQuickPills();
  }

  function addCategoryChipFromInput() {
    commitPendingTag('categoriesContainer', 'itemCategoryInput', {
      dedupe: true,
      onChange: renderCategoryQuickPills,
    });
    renderCategoryQuickPills();
  }

  // ── Menu CRUD ───────────────────────────────────────────────────────────────
  function openMenuModal(menuId = null) {
    const form = document.getElementById('menuForm');
    if (form) form.reset();
    document.getElementById('menuId').value = '';
    document.getElementById('menuModalTitle').textContent = 'Add New Menu';
    document.getElementById('menuIsActive').checked = true;
    const descEl = document.getElementById('menuModal')?.querySelector('.modal-description');
    if (descEl) descEl.textContent = 'Create a new menu for your restaurant.';

    if (menuId) {
      const menu = menus.find((m) => m.id === menuId);
      if (menu) {
        document.getElementById('menuId').value = menu.id;
        document.getElementById('menuName').value = menu.name;
        document.getElementById('menuDescription').value = menu.description || '';
        document.getElementById('menuDisplayOrder').value = menu.display_order || 0;
        document.getElementById('menuIsActive').checked = menu.is_active !== false;
        document.getElementById('menuModalTitle').textContent = 'Edit Menu';
        if (descEl) descEl.textContent = 'Update menu details.';
      }
    }
    openModalEl('menuModal');
  }

  async function saveMenu() {
    const menuId = document.getElementById('menuId').value;
    const body = {
      restaurantId: cfg.getRestaurantId(),
      name: document.getElementById('menuName').value.trim(),
      description: document.getElementById('menuDescription').value.trim(),
      display_order: parseInt(document.getElementById('menuDisplayOrder').value, 10) || 0,
      is_active: document.getElementById('menuIsActive').checked,
    };

    if (!body.name) {
      cfg.notify('Validation', 'Menu name is required', 'warning');
      return;
    }

    try {
      cfg.showLoading();
      const url = menuId ? `${cfg.apiBase}/menus/${menuId}` : `${cfg.apiBase}/menus`;
      const method = menuId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        cfg.notify('Success', `Menu ${menuId ? 'updated' : 'created'} successfully`, 'success');
        closeModalEl('menuModal');
        await loadMenus();
        cfg.onChanged();
      } else {
        cfg.notify('Error', data.error || 'Failed to save menu', 'error');
      }
    } catch (err) {
      console.error(err);
      cfg.notify('Error', 'Failed to save menu', 'error');
    } finally {
      cfg.hideLoading();
    }
  }

  function editMenu(menuId) {
    openMenuModal(menuId);
  }

  function confirmDeleteMenu(menuId) {
    document.getElementById('deleteMessage').textContent = 'Delete this menu and all its items? This cannot be undone.';
    deleteCallback = () => deleteMenu(menuId);
    openModalEl('deleteModal');
  }

  async function deleteMenu(menuId) {
    try {
      cfg.showLoading();
      const res = await fetch(`${cfg.apiBase}/menus/${menuId}`, { method: 'DELETE', credentials: 'same-origin' });
      const data = await res.json();
      if (data.success) {
        cfg.notify('Success', 'Menu deleted successfully', 'success');
        closeModalEl('deleteModal');
        await loadMenus();
        cfg.onChanged();
      } else {
        cfg.notify('Error', data.error || 'Failed to delete menu', 'error');
      }
    } catch (err) {
      cfg.notify('Error', 'Failed to delete menu', 'error');
    } finally {
      cfg.hideLoading();
    }
  }

  // ── Customization & Option Groups Builder ───────────────────────────────────
  function normalizeCustomizationGroup(raw, idx = 0) {
    const type = raw?.type === 'multiple' || Number(raw?.max_select) > 1 ? 'multiple' : 'single';
    const options = Array.isArray(raw?.options)
      ? raw.options.map((opt, optIdx) => {
          if (typeof opt === 'string') {
            return { id: `opt_${idx}_${optIdx}`, name: opt, price: 0, is_available: true };
          }
          return {
            id: opt?.id || `opt_${idx}_${optIdx}`,
            name: String(opt?.name || opt?.label || '').trim(),
            price: Number(opt?.price ?? opt?.priceDelta ?? 0) || 0,
            is_available: opt?.is_available !== false,
          };
        })
      : [];
    return {
      id: raw?.id || `grp_${Date.now()}_${idx}`,
      name: String(raw?.name || '').trim(),
      required: Boolean(raw?.required),
      type,
      min_select: raw?.required ? Math.max(1, Number(raw?.min_select) || 1) : 0,
      max_select: type === 'multiple' ? (Number(raw?.max_select) || Math.max(options.length, 3)) : 1,
      options,
    };
  }

  function syncCustomizationDomToState() {
    const container = document.getElementById('customizationsContainer');
    if (!container) return;
    const groupCards = container.querySelectorAll('.cust-group-card');
    if (!groupCards.length) return;

    currentCustomizationGroups = Array.from(groupCards).map((card, gIdx) => {
      const name = card.querySelector('.cust-group-name')?.value?.trim() || '';
      const required = Boolean(card.querySelector('.cust-group-required')?.checked);
      const type = card.querySelector('.cust-group-type')?.value || 'single';
      const maxSelectVal = parseInt(card.querySelector('.cust-group-max')?.value, 10) || 1;
      const optionRows = card.querySelectorAll('.cust-option-row');
      const options = Array.from(optionRows).map((row, oIdx) => ({
        id: row.dataset.optId || `opt_${gIdx}_${oIdx}`,
        name: row.querySelector('.cust-opt-name')?.value?.trim() || '',
        price: parseFloat(row.querySelector('.cust-opt-price')?.value) || 0,
        is_available: Boolean(row.querySelector('.cust-opt-avail')?.checked),
      }));
      return {
        id: card.dataset.groupId || `grp_${gIdx}`,
        name,
        required,
        type,
        min_select: required ? 1 : 0,
        max_select: type === 'multiple' ? Math.max(1, maxSelectVal) : 1,
        options,
      };
    });
  }

  function renderCustomizationGroups() {
    const container = document.getElementById('customizationsContainer');
    if (!container) return;

    if (!currentCustomizationGroups.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:1rem;border:1px dashed hsl(var(--border));border-radius:var(--radius);color:hsl(var(--muted-foreground));font-size:0.82rem;">
          No option groups added yet. Click <strong>Add Option Group</strong> or choose a preset above to make this item customizable.
        </div>`;
      return;
    }

    container.innerHTML = currentCustomizationGroups.map((group, gIdx) => `
      <div class="cust-group-card" data-group-id="${escapeHtml(group.id)}" style="background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:var(--radius);padding:0.875rem;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;">
          <div style="flex:1;min-width:180px;">
            <label class="form-label" style="font-size:0.75rem;margin-bottom:0.25rem;">Group Title *</label>
            <input type="text" class="form-input cust-group-name" value="${escapeHtml(group.name)}" placeholder="e.g., Choose Size, Extra Toppings">
          </div>
          <div style="width:165px;">
            <label class="form-label" style="font-size:0.75rem;margin-bottom:0.25rem;">Selection Mode</label>
            <select class="form-select cust-group-type" onchange="onGroupTypeChange(${gIdx}, this.value)">
              <option value="single" ${group.type === 'single' ? 'selected' : ''}>Single Choice (1)</option>
              <option value="multiple" ${group.type === 'multiple' ? 'selected' : ''}>Multiple Choice</option>
            </select>
          </div>
          <div style="width:90px;${group.type === 'multiple' ? '' : 'display:none;'}" class="cust-group-max-wrap">
            <label class="form-label" style="font-size:0.75rem;margin-bottom:0.25rem;">Max Pick</label>
            <input type="number" class="form-input cust-group-max" min="1" max="20" value="${group.max_select || 3}">
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem;padding-top:1.1rem;">
            <input type="checkbox" class="toggle-switch cust-group-required" id="custReq_${gIdx}" ${group.required ? 'checked' : ''}>
            <label class="toggle-label" for="custReq_${gIdx}" style="font-size:0.78rem;">Required</label>
          </div>
          <div style="padding-top:1.1rem;">
            <button type="button" class="btn btn-ghost btn-icon" style="color:hsl(var(--destructive));" onclick="removeCustomizationGroup(${gIdx})" title="Remove Group">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>

        <div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px dashed hsl(var(--border));">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
            <span style="font-size:0.75rem;font-weight:600;color:hsl(var(--muted-foreground));">OPTIONS &amp; PRICE MODIFIERS</span>
            <button type="button" class="btn btn-sm btn-outline" style="height:1.75rem;font-size:0.75rem;" onclick="addOptionToGroup(${gIdx})">
              <i class="fas fa-plus"></i> Add Choice
            </button>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.45rem;">
            ${(group.options || []).map((opt, oIdx) => `
              <div class="cust-option-row" data-opt-id="${escapeHtml(opt.id || `opt_${gIdx}_${oIdx}`)}" style="display:flex;align-items:center;gap:0.5rem;">
                <input type="text" class="form-input cust-opt-name" style="flex:1;" value="${escapeHtml(opt.name)}" placeholder="Option name (e.g., Large, Extra Cheese)">
                <div style="position:relative;width:120px;">
                  <span style="position:absolute;left:0.6rem;top:50%;transform:translateY(-50%);color:hsl(var(--muted-foreground));font-size:0.78rem;">+R</span>
                  <input type="number" class="form-input cust-opt-price" step="0.50" min="0" style="padding-left:1.85rem;" value="${Number(opt.price || 0)}" placeholder="0.00">
                </div>
                <label style="display:flex;align-items:center;gap:0.35rem;font-size:0.75rem;white-space:nowrap;cursor:pointer;" title="Option In Stock">
                  <input type="checkbox" class="cust-opt-avail" ${opt.is_available !== false ? 'checked' : ''} style="width:auto;height:auto;">
                  <span>In Stock</span>
                </label>
                <button type="button" class="btn btn-ghost btn-icon" style="color:hsl(var(--destructive));width:1.75rem;height:1.75rem;" onclick="removeOptionFromGroup(${gIdx}, ${oIdx})" title="Remove choice">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `).join('');
  }

  function addCustomizationGroup(initialGroup = null) {
    syncCustomizationDomToState();
    const newGroup = initialGroup
      ? normalizeCustomizationGroup(initialGroup, currentCustomizationGroups.length)
      : {
          id: `grp_${Date.now()}_${currentCustomizationGroups.length}`,
          name: '',
          required: false,
          type: 'single',
          min_select: 0,
          max_select: 1,
          options: [
            { id: `opt_${Date.now()}_0`, name: '', price: 0, is_available: true },
            { id: `opt_${Date.now()}_1`, name: '', price: 0, is_available: true },
          ],
        };
    currentCustomizationGroups.push(newGroup);
    renderCustomizationGroups();
  }

  function addPresetGroup(presetKey) {
    const presets = {
      size: {
        name: 'Choose Size',
        required: true,
        type: 'single',
        min_select: 1,
        max_select: 1,
        options: [
          { name: 'Regular', price: 0, is_available: true },
          { name: 'Medium', price: 15, is_available: true },
          { name: 'Large', price: 25, is_available: true },
        ],
      },
      spice: {
        name: 'Spice / Heat Level',
        required: true,
        type: 'single',
        min_select: 1,
        max_select: 1,
        options: [
          { name: 'Lemon & Herb', price: 0, is_available: true },
          { name: 'Mild', price: 0, is_available: true },
          { name: 'Hot', price: 0, is_available: true },
          { name: 'Extra Hot', price: 0, is_available: true },
        ],
      },
      side: {
        name: 'Choice of Side',
        required: true,
        type: 'single',
        min_select: 1,
        max_select: 1,
        options: [
          { name: 'Regular Chips', price: 0, is_available: true },
          { name: 'Spicy Rice', price: 0, is_available: true },
          { name: 'Garden Salad', price: 5, is_available: true },
          { name: 'Sweet Potato Fries', price: 18, is_available: true },
        ],
      },
      extras: {
        name: 'Extra Toppings & Add-ons',
        required: false,
        type: 'multiple',
        min_select: 0,
        max_select: 5,
        options: [
          { name: 'Extra Cheese', price: 15, is_available: true },
          { name: 'Crispy Bacon', price: 22, is_available: true },
          { name: 'Fresh Avocado', price: 20, is_available: true },
          { name: 'Extra Sauce', price: 10, is_available: true },
        ],
      },
    };
    if (presets[presetKey]) addCustomizationGroup(presets[presetKey]);
  }

  function onGroupTypeChange(groupIdx, newType) {
    syncCustomizationDomToState();
    if (currentCustomizationGroups[groupIdx]) {
      currentCustomizationGroups[groupIdx].type = newType;
      currentCustomizationGroups[groupIdx].max_select = newType === 'multiple'
        ? Math.max(2, currentCustomizationGroups[groupIdx].options.length || 3)
        : 1;
      renderCustomizationGroups();
    }
  }

  function removeCustomizationGroup(groupIdx) {
    syncCustomizationDomToState();
    currentCustomizationGroups.splice(groupIdx, 1);
    renderCustomizationGroups();
  }

  function addOptionToGroup(groupIdx) {
    syncCustomizationDomToState();
    if (!currentCustomizationGroups[groupIdx]) return;
    currentCustomizationGroups[groupIdx].options.push({
      id: `opt_${Date.now()}_${currentCustomizationGroups[groupIdx].options.length}`,
      name: '',
      price: 0,
      is_available: true,
    });
    renderCustomizationGroups();
  }

  function removeOptionFromGroup(groupIdx, optIdx) {
    syncCustomizationDomToState();
    if (!currentCustomizationGroups[groupIdx]) return;
    currentCustomizationGroups[groupIdx].options.splice(optIdx, 1);
    renderCustomizationGroups();
  }

  function getValidatedCustomizations() {
    syncCustomizationDomToState();
    return currentCustomizationGroups
      .map((grp, gIdx) => {
        const validOptions = (grp.options || [])
          .filter((o) => o.name && o.name.trim().length > 0)
          .map((o, oIdx) => ({
            id: o.id || `opt_${gIdx}_${oIdx}`,
            name: o.name.trim(),
            price: Number(o.price) || 0,
            is_available: o.is_available !== false,
          }));
        return {
          id: grp.id || `grp_${gIdx}`,
          name: (grp.name || '').trim(),
          required: Boolean(grp.required),
          type: grp.type === 'multiple' ? 'multiple' : 'single',
          min_select: grp.required ? 1 : 0,
          max_select: grp.type === 'multiple' ? Math.max(1, Number(grp.max_select) || validOptions.length || 1) : 1,
          options: validOptions,
        };
      })
      .filter((grp) => grp.name.length > 0 && grp.options.length > 0);
  }

  // ── Item CRUD ───────────────────────────────────────────────────────────────
  function openItemModal(menuId) {
    document.getElementById('itemForm').reset();
    document.getElementById('itemId').value = '';
    document.getElementById('itemMenuId').value = menuId;
    document.getElementById('itemModalTitle').textContent = 'Add Menu Item';
    document.getElementById('itemIsAvailable').checked = true;
    const descEl = document.getElementById('itemModal')?.querySelector('.modal-description');
    if (descEl) descEl.textContent = 'Add a new item and assign one or more categories.';

    setTags('categoriesContainer', activeCategory !== 'all' ? [activeCategory] : [], {
      dedupe: true,
      onChange: renderCategoryQuickPills,
    });
    setTags('ingredientsContainer', []);
    setTags('tagsContainer', []);
    renderCategoryQuickPills();

    currentCustomizationGroups = [];
    renderCustomizationGroups();
    openModalEl('itemModal');
  }

  async function editItem(itemId) {
    try {
      cfg.showLoading();
      const res = await fetch(`${cfg.apiBase}/menu-items/${itemId}`, { credentials: 'same-origin' });
      const data = await res.json();

      if (data.success && data.item) {
        const item = data.item;
        document.getElementById('itemId').value = item.id;
        document.getElementById('itemMenuId').value = item.menu_id;
        document.getElementById('itemName').value = item.name;
        document.getElementById('itemDescription').value = item.description || '';
        document.getElementById('itemPrice').value = item.price;
        document.getElementById('itemDiscountedPrice').value = item.discounted_price || '';
        document.getElementById('itemPrepTime').value = item.preparation_time_minutes || 15;
        document.getElementById('itemCalories').value = item.calories || '';
        document.getElementById('itemImageUrl').value = item.image_url || '';
        document.getElementById('itemIsAvailable').checked = item.is_available !== false;
        document.getElementById('itemIsVeg').checked = item.is_veg === true;
        document.getElementById('itemIsPopular').checked = item.is_popular === true;
        document.getElementById('itemModalTitle').textContent = 'Edit Menu Item';
        const descEl = document.getElementById('itemModal')?.querySelector('.modal-description');
        if (descEl) descEl.textContent = 'Update item details, categories, and customization options.';

        const parsedIng = Array.isArray(item.ingredients)
          ? item.ingredients
          : (() => { try { return JSON.parse(item.ingredients || '[]'); } catch { return []; } })();
        const parsedTags = Array.isArray(item.tags) ? item.tags : [];

        setTags('categoriesContainer', getItemCategories(item), {
          dedupe: true,
          onChange: renderCategoryQuickPills,
        });
        setTags('ingredientsContainer', parsedIng);
        setTags('tagsContainer', parsedTags);
        renderCategoryQuickPills();

        const rawCustomizations = Array.isArray(item.customizations)
          ? item.customizations
          : (typeof item.customizations === 'string' && item.customizations.trim()
            ? JSON.parse(item.customizations)
            : []);
        currentCustomizationGroups = rawCustomizations.map((g, idx) => normalizeCustomizationGroup(g, idx));
        renderCustomizationGroups();
        openModalEl('itemModal');
      } else {
        cfg.notify('Error', data.error || 'Failed to load item details', 'error');
      }
    } catch (err) {
      console.error(err);
      cfg.notify('Error', 'Failed to load item details', 'error');
    } finally {
      cfg.hideLoading();
    }
  }

  async function saveItem() {
    commitPendingTag('categoriesContainer', 'itemCategoryInput', {
      dedupe: true,
      onChange: renderCategoryQuickPills,
    });
    commitPendingTag('ingredientsContainer', 'ingredientsInput');
    commitPendingTag('tagsContainer', 'tagsInput');

    const itemId = document.getElementById('itemId').value;
    const menuId = document.getElementById('itemMenuId').value;
    const customizations = getValidatedCustomizations();
    const categories = getTags('categoriesContainer');

    const body = {
      menuId,
      restaurantId: cfg.getRestaurantId(),
      name: document.getElementById('itemName').value.trim(),
      category: categories[0] || '',
      categories,
      description: document.getElementById('itemDescription').value.trim(),
      price: parseFloat(document.getElementById('itemPrice').value),
      discounted_price: parseFloat(document.getElementById('itemDiscountedPrice').value) || null,
      preparation_time_minutes: parseInt(document.getElementById('itemPrepTime').value, 10) || 15,
      calories: parseInt(document.getElementById('itemCalories').value, 10) || null,
      image_url: document.getElementById('itemImageUrl').value.trim() || null,
      is_available: document.getElementById('itemIsAvailable').checked,
      is_veg: document.getElementById('itemIsVeg').checked,
      is_popular: document.getElementById('itemIsPopular').checked,
      ingredients: getTags('ingredientsContainer'),
      tags: getTags('tagsContainer'),
      customizations,
    };

    if (!body.name || categories.length === 0 || isNaN(body.price)) {
      cfg.notify('Validation', 'Name, at least one category, and price are required', 'warning');
      return;
    }

    try {
      cfg.showLoading();
      const url = itemId ? `${cfg.apiBase}/menu-items/${itemId}` : `${cfg.apiBase}/menu-items`;
      const method = itemId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        cfg.notify('Success', `Item ${itemId ? 'updated' : 'created'} successfully`, 'success');
        closeModalEl('itemModal');
        await loadMenus();
        cfg.onChanged();
      } else {
        cfg.notify('Error', data.error || 'Failed to save item', 'error');
      }
    } catch (err) {
      console.error(err);
      cfg.notify('Error', 'Failed to save item', 'error');
    } finally {
      cfg.hideLoading();
    }
  }

  function confirmDeleteItem(itemId) {
    document.getElementById('deleteMessage').textContent = 'Delete this menu item?';
    deleteCallback = () => deleteItem(itemId);
    openModalEl('deleteModal');
  }

  async function deleteItem(itemId) {
    try {
      cfg.showLoading();
      const res = await fetch(`${cfg.apiBase}/menu-items/${itemId}`, { method: 'DELETE', credentials: 'same-origin' });
      const data = await res.json();
      if (data.success) {
        cfg.notify('Success', 'Item deleted successfully', 'success');
        closeModalEl('deleteModal');
        await loadMenus();
        cfg.onChanged();
      } else {
        cfg.notify('Error', data.error || 'Failed to delete item', 'error');
      }
    } catch (err) {
      cfg.notify('Error', 'Failed to delete item', 'error');
    } finally {
      cfg.hideLoading();
    }
  }

  async function toggleItemAvailability(itemId, makeAvailable) {
    try {
      cfg.showLoading();
      const res = await fetch(`${cfg.apiBase}/menu-items/${itemId}/toggle-availability`, {
        method: 'PATCH',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.success) {
        cfg.notify('Success', `Item ${makeAvailable ? 'enabled' : 'disabled'}`, 'success');
        await loadMenus();
      } else {
        cfg.notify('Error', data.error || 'Failed to toggle availability', 'error');
      }
    } catch (err) {
      cfg.notify('Error', 'Failed to toggle availability', 'error');
    } finally {
      cfg.hideLoading();
    }
  }

  async function uploadMenuItemImage(fileInput) {
    if (!cfg.uploadEndpoint) return;
    const file = fileInput?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    cfg.notify('Uploading Image...', file.name, 'info');
    try {
      const res = await fetch(cfg.uploadEndpoint, { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Upload failed');
      document.getElementById('itemImageUrl').value = data.url;
      cfg.notify('Upload Complete', 'Item image URL populated.', 'success');
    } catch (err) {
      cfg.notify('Upload Note', err.message, 'warning');
    }
  }

  // ── Category Modal ──────────────────────────────────────────────────────────
  function openCategoryModal() {
    renderCategoriesList();
    openModalEl('categoryModal');
  }

  function renderCategoriesList() {
    const list = document.getElementById('categoriesList');
    if (!list) return;
    const cats = Array.from(allCategories).sort();
    if (!cats.length) {
      list.innerHTML = '<div class="empty-state" style="padding:1rem;"><p style="font-size:0.875rem;">No categories yet</p></div>';
      return;
    }
    list.innerHTML = cats.map((cat) => `
      <div class="list-group-item">
        <span>${escapeHtml(cat)}</span>
        <button type="button" class="btn btn-ghost btn-icon" style="color:hsl(var(--destructive));" onclick="removeCategory('${escapeHtml(cat)}')">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `).join('');
  }

  function addCategory() {
    const input = document.getElementById('newCategoryName');
    const name = input?.value?.trim();
    if (!name) return;
    allCategories.add(name);
    input.value = '';
    renderCategories();
    renderCategoriesList();
    cfg.notify('Success', 'Category added', 'success');
  }

  function removeCategory(category) {
    allCategories.delete(category);
    if (activeCategory === category) activeCategory = 'all';
    renderCategories();
    renderCategoriesList();
  }

  // ── Tag & Category Chips ────────────────────────────────────────────────────
  function getChipValue(chip) {
    return (chip?.dataset?.value || chip?.textContent?.replace('×', '') || '').trim();
  }

  function setupTagInputs() {
    const configs = [
      { containerId: 'categoriesContainer', inputId: 'itemCategoryInput', dedupe: true, onChange: renderCategoryQuickPills },
      { containerId: 'ingredientsContainer', inputId: 'ingredientsInput', dedupe: false },
      { containerId: 'tagsContainer', inputId: 'tagsInput', dedupe: false },
    ];

    configs.forEach(({ containerId, inputId, dedupe, onChange }) => {
      const container = document.getElementById(containerId);
      const input = document.getElementById(inputId);
      if (!container || !input) return;

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const val = input.value.replace(/,/g, '').trim();
          if (val) {
            addTagChip(container, val, { dedupe, onChange });
            input.value = '';
          }
        }
        if (e.key === 'Backspace' && !input.value) {
          const chips = container.querySelectorAll('.tag-chip');
          if (chips.length) {
            chips[chips.length - 1].remove();
            if (typeof onChange === 'function') onChange();
          }
        }
      });

      // Automatically turn datalist selections into chips too
      if (inputId === 'itemCategoryInput') {
        input.addEventListener('change', () => {
          const val = input.value.trim();
          if (val && Array.from(allCategories).some((c) => c.toLowerCase() === val.toLowerCase())) {
            addTagChip(container, val, { dedupe: true, onChange });
            input.value = '';
          }
        });
      }
    });
  }

  function commitPendingTag(containerId, inputId, options = {}) {
    const container = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    if (!container || !input) return;
    const raw = input.value.trim();
    if (!raw) return;
    raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((part) => addTagChip(container, part, options));
    input.value = '';
  }

  function addTagChip(container, text, options = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (options.dedupe) {
      const exists = Array.from(container.querySelectorAll('.tag-chip')).some(
        (c) => getChipValue(c).toLowerCase() === clean.toLowerCase()
      );
      if (exists) return;
    }

    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    chip.dataset.value = clean;
    chip.innerHTML = `${escapeHtml(clean)} <button type="button" aria-label="Remove">&times;</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      chip.remove();
      if (typeof options.onChange === 'function') options.onChange();
    });
    container.insertBefore(chip, container.querySelector('.tag-input'));
    if (typeof options.onChange === 'function') options.onChange();
  }

  function getTags(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.tag-chip')).map(getChipValue).filter(Boolean);
  }

  function setTags(containerId, tags, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.tag-chip').forEach((c) => c.remove());
    (tags || []).forEach((t) => addTagChip(container, t, { ...options, onChange: undefined }));
    if (typeof options.onChange === 'function') options.onChange();
  }

  global.MenuEditor = {
    init,
    loadMenus,
    renderMenus,
    openModal: openModalEl,
    closeModal: closeModalEl,
  };

  // Expose onclick handlers globally so shared modals work cleanly on both Admin and Partner portals
  global.openMenuModal = openMenuModal;
  global.saveMenu = saveMenu;
  global.editMenu = editMenu;
  global.confirmDeleteMenu = confirmDeleteMenu;
  global.openItemModal = openItemModal;
  global.editItem = editItem;
  global.saveItem = saveItem;
  global.confirmDeleteItem = confirmDeleteItem;
  global.toggleItemAvailability = toggleItemAvailability;
  global.uploadMenuItemImage = uploadMenuItemImage;
  global.openCategoryModal = openCategoryModal;
  global.addCategory = addCategory;
  global.removeCategory = removeCategory;
  global.addCategoryChipFromInput = addCategoryChipFromInput;
  global.addCustomizationGroup = addCustomizationGroup;
  global.addPresetGroup = addPresetGroup;
  global.onGroupTypeChange = onGroupTypeChange;
  global.removeCustomizationGroup = removeCustomizationGroup;
  global.addOptionToGroup = addOptionToGroup;
  global.removeOptionFromGroup = removeOptionFromGroup;
})(window);
