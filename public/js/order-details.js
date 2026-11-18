/* Shared Kitchen Prep & Comprehensive Order Detail Renderer
   Used by both /restaurant/* (Partner Portal) and /manager/orders (Happy Admin) */
(function (global) {
  'use strict';

  const orderCache = new Map();

  function esc(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function safeId(val) {
    return String(val || '').replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function parseJsonObj(val) {
    if (!val) return null;
    if (typeof val === 'object') return val;
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function fmtMoney(n) {
    return parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-ZA', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function relativeTime(d) {
    if (!d) return '';
    const diff = Date.now() - new Date(d).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function parseAddress(raw) {
    if (!raw) return 'No address provided';
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (typeof obj === 'string') return obj;
      const parts = [
        obj.street || obj.address_line1 || obj.line1 || obj.formatted,
        obj.suburb || obj.address_line2 || obj.line2,
        obj.city,
        obj.province || obj.state,
        obj.postal_code || obj.zip,
      ].filter(Boolean);
      return parts.length ? parts.join(', ') : JSON.stringify(obj);
    } catch {
      return String(raw);
    }
  }

  function parseSelectedOptions(rawOptions) {
    if (!rawOptions) return [];
    let parsed = rawOptions;
    if (typeof rawOptions === 'string') {
      try {
        parsed = JSON.parse(rawOptions);
      } catch {
        return [];
      }
    }
    if (!parsed || typeof parsed !== 'object') return [];

    const groups = [];
    Object.entries(parsed).forEach(([groupName, val]) => {
      if (val === null || val === undefined || val === '') return;
      if (Array.isArray(val)) {
        const values = val
          .map((entry) => {
            if (entry && typeof entry === 'object') {
              const label = entry.name || entry.label || '';
              const price = Number(entry.price ?? entry.priceDelta ?? 0);
              return label ? { label, price } : null;
            }
            const s = String(entry || '').trim();
            return s ? { label: s, price: 0 } : null;
          })
          .filter(Boolean);
        if (values.length) groups.push({ groupName, values });
      } else if (typeof val === 'object') {
        const label = val.name || val.label || '';
        const price = Number(val.price ?? val.priceDelta ?? 0);
        if (label) groups.push({ groupName, values: [{ label, price }] });
      } else {
        const s = String(val).trim();
        if (s) groups.push({ groupName, values: [{ label: s, price: 0 }] });
      }
    });
    return groups;
  }

  function formatSelectedOptionsHtml(rawOptions, { showPrice = true } = {}) {
    const groups = parseSelectedOptions(rawOptions);
    if (!groups.length) return '';

    const chips = groups.map((g) => {
      const valText = g.values
        .map((v) => {
          const priceStr = showPrice && v.price > 0 ? ` (+R${fmtMoney(v.price)})` : '';
          return `${esc(v.label)}${priceStr}`;
        })
        .join(', ');
      return `<span class="prep-chip"><strong>${esc(g.groupName)}:</strong> ${valText}</span>`;
    });

    return `<div class="prep-chips-wrap">${chips.join('')}</div>`;
  }

  function summarizeOptionText(rawOptions) {
    const groups = parseSelectedOptions(rawOptions);
    if (!groups.length) return '';
    return groups
      .map((g) => g.values.map((v) => v.label).join(', '))
      .filter(Boolean)
      .join(' · ');
  }

  function rememberOrder(order, items) {
    if (!order || !order.id) return;
    orderCache.set(String(order.id), {
      order,
      items: Array.isArray(items) ? items : (Array.isArray(order.items) ? order.items : []),
    });
  }

  function rememberOrders(orders) {
    if (!Array.isArray(orders)) return;
    orders.forEach((o) => rememberOrder(o, o.items));
  }

  function renderCompactItemsPreview(items, fallbackCount = 0) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      return `<span style="color:hsl(var(--muted-foreground));font-size:0.82rem;">${fallbackCount || 0} item${fallbackCount === 1 ? '' : 's'}</span>`;
    }

    const visible = list.slice(0, 2);
    const remaining = list.length - visible.length;
    const hasNotes = list.some((it) => it.special_instructions && String(it.special_instructions).trim());
    const hasAllergens = list.some((it) => it.allergen_notes && String(it.allergen_notes).trim());

    const linesHtml = visible
      .map((it) => {
        const optSummary = summarizeOptionText(it.selected_options);
        return `
          <div class="prep-preview-line">
            <span class="prep-preview-qty">${Number(it.quantity) || 1}×</span>
            <span>${esc(it.item_name)}</span>
            ${optSummary ? `<span class="prep-preview-opts">(${esc(optSummary)})</span>` : ''}
          </div>`;
      })
      .join('');

    const moreHtml = remaining > 0
      ? `<div style="font-size:0.74rem;color:hsl(var(--primary));font-weight:600;">+${remaining} more item${remaining > 1 ? 's' : ''}</div>`
      : '';

    const flagsHtml = (hasNotes || hasAllergens)
      ? `<div class="prep-preview-flags">
           ${hasAllergens ? `<span class="prep-flag-badge prep-flag-allergy">Allergy Alert</span>` : ''}
           ${hasNotes ? `<span class="prep-flag-badge prep-flag-note">Prep Note</span>` : ''}
         </div>`
      : '';

    return `<div class="prep-items-preview">${linesHtml}${moreHtml}${flagsHtml}</div>`;
  }

  function renderOrderItemsList(items, { kitchenMode = false } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      return `<div style="padding:1.25rem;text-align:center;color:hsl(var(--muted-foreground));font-size:0.85rem;">No item details available</div>`;
    }

    return list
      .map((it) => {
        const qty = Number(it.quantity) || 1;
        const unitPrice = Number(it.unit_price || 0);
        const lineTotal = it.total_price != null ? Number(it.total_price) : unitPrice * qty;
        const optionsHtml = formatSelectedOptionsHtml(it.selected_options, { showPrice: !kitchenMode });

        const thumbHtml = !kitchenMode
          ? `<div class="od-item-thumb">
               ${it.image_url
                 ? `<img src="${esc(it.image_url)}" alt="${esc(it.item_name)}" onerror="this.remove()">`
                 : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`}
             </div>`
          : '';

        return `
          <div class="od-item-row">
            ${thumbHtml}
            <div style="flex:1;min-width:0;">
              <div class="od-item-title-line">
                <span class="od-qty-badge">${qty}×</span>
                <span>${esc(it.item_name)}</span>
                ${!kitchenMode && unitPrice > 0 ? `<span class="od-item-unit">@ R${fmtMoney(unitPrice)}</span>` : ''}
              </div>
              ${optionsHtml}
              ${it.special_instructions && String(it.special_instructions).trim()
                ? `<div class="prep-alert prep-alert-note"><span>📝</span><div><strong>Item Note:</strong> ${esc(it.special_instructions)}</div></div>`
                : ''}
              ${it.allergen_notes && String(it.allergen_notes).trim()
                ? `<div class="prep-alert prep-alert-allergy"><span>⚠️</span><div><strong>Allergy / Dietary Alert:</strong> ${esc(it.allergen_notes)}</div></div>`
                : ''}
            </div>
            ${!kitchenMode ? `<div class="od-item-total">R${fmtMoney(lineTotal)}</div>` : ''}
          </div>
        `;
      })
      .join('');
  }

  function buildOrderTimelineHtml(order) {
    if (order.status === 'delivery_failed') {
      return `
        <div class="prep-alert prep-alert-allergy">
          <span>⛔</span>
          <div>
            <strong>Delivery Failed — Customer Unreachable (Payment Forfeited)</strong>
            ${order.failure_reason ? `<div style="margin-top:3px;font-weight:500;">${esc(order.failure_reason)}</div>` : ''}
            ${order.cancelled_at ? `<div style="margin-top:2px;font-size:0.76rem;opacity:0.85;">Closed at ${esc(fmtDateTime(order.cancelled_at))} · Driver compensated; no customer refund.</div>` : ''}
          </div>
        </div>
      `;
    }

    const isCancelled = order.status === 'cancelled' || order.status === 'no_drivers_available';
    if (isCancelled) {
      return `
        <div class="prep-alert prep-alert-allergy">
          <span>✕</span>
          <div>
            Order ${order.status === 'cancelled' ? 'rejected / cancelled' : 'could not find an available driver'}
            ${order.cancelled_at ? ` at ${esc(fmtDateTime(order.cancelled_at))}` : ''}
            ${order.failure_reason ? `<div style="margin-top:3px;font-weight:500;">Reason: ${esc(order.failure_reason)}</div>` : ''}
          </div>
        </div>
      `;
    }

    const steps = [
      { key: 'pending', label: 'Order Placed (Pending Approval)', field: 'placed_at' },
      {
        key: 'ordering_at_restaurant',
        label: order.payment_status === 'completed'
          ? 'Accepted & Paid (Kitchen Prep / Finding Driver)'
          : 'Accepted by Restaurant (Awaiting Customer Payment)',
        field: 'restaurant_notified_at',
      },
      { key: 'accepted_by_driver', label: 'Driver Assigned', field: 'accepted_at' },
      { key: 'order_ready', label: 'Order Ready for Pickup', field: 'ready_for_pickup_at' },
      { key: 'picked_up', label: 'Picked Up by Driver', field: 'picked_up_at' },
      { key: 'on_the_way', label: 'On the Way to Customer', field: null },
      { key: 'arrived', label: 'Arrived at Customer', field: null },
      { key: 'delivered', label: 'Delivered', field: 'delivered_at' },
    ];

    const currentIdx = steps.findIndex((s) => s.key === order.status);
    return `
      <ul class="od-timeline">
        ${steps
          .map((step, idx) => {
            const done = idx <= currentIdx;
            const current = idx === currentIdx;
            const dotClass = done ? (current && order.status !== 'delivered' ? 'current' : 'done') : 'future';
            const timeVal = step.field ? order[step.field] : null;
            return `
              <li>
                <span class="od-tl-dot ${dotClass}"></span>
                <span style="font-weight:${done ? 600 : 400};color:${done ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))'};">${esc(step.label)}</span>
                <span style="font-size:0.76rem;color:hsl(var(--muted-foreground));white-space:nowrap;">${timeVal ? esc(fmtDateTime(timeVal)) : ''}</span>
              </li>
            `;
          })
          .join('')}
      </ul>
    `;
  }

  function renderOrderDetailContent(order, items, options = {}) {
    rememberOrder(order, items);

    const {
      apiBase = '/restaurant/api',
      showRestaurant = false,
      statusText = order.status,
      statusBadgeClass = 'badge-gray',
      paymentText = order.payment_status,
      paymentBadgeClass = 'badge-gray',
      paymentMethodText = order.payment_method || 'card',
      actionsBannerHtml = '',
    } = options;

    const addrStr = parseAddress(order.delivery_address);
    const subtotal = parseFloat(order.subtotal || 0);
    const delivery = parseFloat(order.delivery_fee || 0);
    const tax = parseFloat(order.tax_amount || 0);
    const tip = parseFloat(order.tip_amount || 0);
    const total = parseFloat(order.total_amount || 0);
    const oid = safeId(order.id);
    const cleanApiBase = String(apiBase || '/restaurant/api').replace(/'/g, '');
    const rescue = parseJsonObj(order.rescue_courier);
    const supportPhone = options.supportPhone || order.support_phone || '';
    const incidents = Array.isArray(order.incidents) ? order.incidents : [];

    let driverHtml = '';
    if (rescue && rescue.name) {
      driverHtml = `<div class="od-rescue-card">
           <div>
             <div style="font-size:0.7rem;color:#065f46;font-weight:800;">${esc((rescue.courier_type_label || 'RESCUE COURIER').toUpperCase())}</div>
             <div style="font-weight:800;font-size:0.94rem;color:#064e3b;">🛡️ ${esc(rescue.name)}</div>
             ${rescue.assigned_at ? `<div style="font-size:0.72rem;color:#047857;">Dispatched ${esc(relativeTime(rescue.assigned_at))} · Happy Paid/Direct</div>` : ''}
           </div>
           <div>
             <div style="font-size:0.7rem;color:#065f46;font-weight:800;">PHONE</div>
             <div style="font-weight:700;">${rescue.phone ? `<a href="tel:${esc(rescue.phone)}" style="color:#047857;">📞 ${esc(rescue.phone)}</a>` : '—'}</div>
           </div>
           <div>
             <div style="font-size:0.7rem;color:#065f46;font-weight:800;">VEHICLE & DETAILS</div>
             <div style="font-weight:700;">${esc(rescue.vehicle || 'Dispatch Rescue')} ${rescue.plate ? `(${esc(rescue.plate)})` : ''}</div>
             ${rescue.notes ? `<div style="font-size:0.74rem;color:#065f46;margin-top:2px;">${esc(rescue.notes)}</div>` : ''}
           </div>
         </div>`;
    } else if (order.driver_name) {
      const safeDriverImg = order.driver_image ? esc(order.driver_image) : '';
      const driverInitials = esc(
        order.driver_name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((p) => p.charAt(0).toUpperCase())
          .join('') || 'DR'
      );
      driverHtml = `<div class="od-driver-card">
           <div style="display:flex;align-items:center;gap:12px;">
             ${safeDriverImg
               ? `<a href="${safeDriverImg}" target="_blank" rel="noopener noreferrer" title="View full driver photo" style="flex-shrink:0;">
                    <img src="${safeDriverImg}" alt="${esc(order.driver_name)}" style="width:52px;height:52px;border-radius:50%;object-fit:cover;border:2px solid #bfdbfe;background:#fff;">
                  </a>`
               : `<div style="width:52px;height:52px;border-radius:50%;background:#dbeafe;color:#1e3a8a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.95rem;flex-shrink:0;">${driverInitials}</div>`}
             <div>
               <div style="font-size:0.7rem;color:#1e3a8a;font-weight:800;">ASSIGNED DRIVER ${order.reassigned_at ? '· REASSIGNED' : ''}</div>
               <div style="font-weight:800;font-size:0.94rem;">${esc(order.driver_name)}</div>
               ${order.accepted_at ? `<div style="font-size:0.72rem;color:#3b82f6;">Accepted ${esc(relativeTime(order.accepted_at))}</div>` : ''}
             </div>
           </div>
           <div>
             <div style="font-size:0.7rem;color:#1e3a8a;font-weight:800;">PHONE</div>
             <div style="font-weight:700;"><a href="tel:${esc(order.driver_phone || '')}" style="color:#1d4ed8;">📞 ${esc(order.driver_phone || '—')}</a></div>
           </div>
           <div>
             <div style="font-size:0.7rem;color:#1e3a8a;font-weight:800;">VEHICLE & PLATE</div>
             <div style="font-weight:700;">${esc([order.driver_vehicle_color, order.driver_vehicle_model || order.driver_vehicle_type].filter(Boolean).join(' ') || 'Vehicle')} ${order.driver_vehicle_plate ? `(${esc(order.driver_vehicle_plate)})` : ''}</div>
           </div>
         </div>`;
    } else {
      driverHtml = `<div class="od-box" style="color:hsl(var(--muted-foreground));">
           ${order.status === 'pending'
             ? 'Accept this order first so the customer can complete payment and dispatch a driver.'
             : order.payment_status !== 'completed' && !['cancelled', 'no_drivers_available', 'delivery_failed'].includes(order.status)
               ? 'Awaiting customer payment completion before dispatching to nearby drivers.'
               : ['cancelled', 'no_drivers_available', 'delivery_failed'].includes(order.status)
                 ? 'No active driver assigned.'
                 : order.reassigned_at
                   ? 'Driver was unassigned by Dispatch — waiting for next available driver to accept...'
                   : 'Searching for an available nearby driver...'}
         </div>`;
    }

    const supportBarHtml = (supportPhone && options.showSupportCall !== false)
      ? `<div class="od-call-strip" style="margin-top:0.45rem;">
           ${(order.driver_phone || rescue?.phone) ? `<a class="od-call-pill primary" href="tel:${esc(rescue?.phone || order.driver_phone)}">📞 Call ${rescue ? 'Courier' : 'Driver'} (${esc(rescue?.phone || order.driver_phone)})</a>` : ''}
           <a class="od-call-pill support" href="tel:${esc(supportPhone)}">🛡️ Call Happy Dispatch (${esc(supportPhone)})</a>
         </div>`
      : '';

    const incidentsHtml = incidents.length > 0
      ? `<div>
           <div class="od-section-label">Dispatch & Incident Log (${incidents.length})</div>
           <div class="od-box">
             <ul class="od-incident-list">
               ${incidents.map((inc) => `
                 <li class="od-incident-item">
                   <div>
                     <strong style="color:#0f172a;">${esc(String(inc.incident_type || '').replace(/_/g, ' ').toUpperCase())}</strong>
                     <div style="color:#475569;margin-top:2px;">${esc(inc.summary || '')}</div>
                   </div>
                   <span style="font-size:0.73rem;color:hsl(var(--muted-foreground));white-space:nowrap;">${esc(fmtDateTime(inc.created_at))}</span>
                 </li>
               `).join('')}
             </ul>
           </div>
         </div>`
      : '';

    const orderInstructionsHtml =
      order.special_instructions || order.delivery_instructions
        ? `<div class="prep-order-banner">
             ${order.special_instructions ? `<div><strong>🍳 Order Kitchen Instructions:</strong> ${esc(order.special_instructions)}</div>` : ''}
             ${order.delivery_instructions ? `<div style="${order.special_instructions ? 'margin-top:4px;' : ''}"><strong>🛵 Delivery Instructions:</strong> ${esc(order.delivery_instructions)}</div>` : ''}
           </div>`
        : '';

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
        <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap;">
          <span class="badge ${esc(statusBadgeClass)}" style="font-size:0.84rem;padding:0.35rem 0.75rem;">${esc(statusText)}</span>
          <span class="badge ${esc(paymentBadgeClass)}">${esc(paymentText)} · ${esc(paymentMethodText)}</span>
        </div>
        <button type="button" class="btn btn-outline btn-sm" onclick="OrderDetails.printKitchenTicketById('${oid}', '${cleanApiBase}')">
          🖨 Print Kitchen Ticket
        </button>
      </div>

      ${actionsBannerHtml}
      ${orderInstructionsHtml}

      <div>
        <div class="od-section-label">Items & Preparation Breakdown (${items.length} line${items.length === 1 ? '' : 's'})</div>
        <div style="border:1px solid hsl(var(--border));border-radius:10px;padding:0 0.9rem;background:#fff;">
          ${renderOrderItemsList(items, { kitchenMode: false })}
        </div>
      </div>

      <div>
        <div class="od-section-label">Assigned Courier / Driver</div>
        ${driverHtml}
        ${supportBarHtml}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0.85rem;">
        <div class="od-box">
          <div style="font-size:0.72rem;font-weight:800;color:hsl(var(--muted-foreground));text-transform:uppercase;">Customer & Delivery Address</div>
          <div style="font-weight:700;margin-top:4px;">${esc(order.customer_name || 'Unknown Customer')}</div>
          <div style="font-size:0.82rem;margin-top:2px;">${order.customer_phone ? `<a href="tel:${esc(order.customer_phone)}" style="color:hsl(var(--primary));font-weight:600;">${esc(order.customer_phone)}</a>` : '—'}</div>
          ${showRestaurant && order.restaurant_name ? `<div style="font-size:0.8rem;margin-top:4px;"><strong>Restaurant:</strong> ${esc(order.restaurant_name)} ${order.restaurant_phone ? `· <a href="tel:${esc(order.restaurant_phone)}" style="color:hsl(var(--primary));font-weight:600;">${esc(order.restaurant_phone)}</a>` : ''}</div>` : ''}
          <div style="font-size:0.8rem;color:hsl(var(--muted-foreground));margin-top:6px;">📍 ${esc(addrStr)}</div>
        </div>
        <div class="od-box" style="display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:0.72rem;font-weight:800;color:hsl(var(--muted-foreground));text-transform:uppercase;margin-bottom:2px;">Financial Summary</div>
          <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><strong>R${fmtMoney(subtotal)}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Delivery Fee</span><strong>R${fmtMoney(delivery)}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Tax</span><strong>R${fmtMoney(tax)}</strong></div>
          ${tip > 0 ? `<div style="display:flex;justify-content:space-between;"><span>Driver Tip</span><strong>R${fmtMoney(tip)}</strong></div>` : ''}
          <div style="display:flex;justify-content:space-between;border-top:1px solid hsl(var(--border));padding-top:6px;margin-top:4px;font-size:1.02rem;color:hsl(var(--primary));font-weight:800;">
            <span>Total</span><span>R${fmtMoney(total)}</span>
          </div>
        </div>
      </div>

      <div>
        <div class="od-section-label">Order Timeline</div>
        <div class="od-box">
          ${buildOrderTimelineHtml(order)}
        </div>
      </div>

      ${incidentsHtml}
    `;
  }

  function printKitchenTicket(order, items) {
    if (!order) return;
    const itemList = Array.isArray(items) ? items : [];
    const addr = parseAddress(order.delivery_address);
    const itemsBlock = itemList
      .map((it) => {
        const groups = parseSelectedOptions(it.selected_options);
        const optLines = groups
          .map((g) => `<div class="opt">• ${esc(g.groupName)}: ${esc(g.values.map((v) => v.label).join(', '))}</div>`)
          .join('');
        const noteLine = it.special_instructions ? `<div class="warn">NOTE: ${esc(it.special_instructions)}</div>` : '';
        const allergyLine = it.allergen_notes ? `<div class="allergy">ALLERGY: ${esc(it.allergen_notes)}</div>` : '';
        return `
          <div class="item">
            <div class="item-head"><span>${Number(it.quantity) || 1}x</span> ${esc(it.item_name)}</div>
            ${optLines}
            ${noteLine}
            ${allergyLine}
          </div>
        `;
      })
      .join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Kitchen Ticket #${esc(order.order_number || '')}</title>
  <style>
    body { font-family: 'Courier New', monospace; width: 320px; margin: 0 auto; padding: 14px; color: #000; font-size: 13px; }
    h2, h3, p { margin: 0 0 6px; }
    .divider { border-top: 2px dashed #000; margin: 10px 0; }
    .meta { font-size: 12px; line-height: 1.45; }
    .item { margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px dotted #999; }
    .item-head { font-size: 15px; font-weight: bold; }
    .item-head span { background: #000; color: #fff; padding: 1px 6px; border-radius: 3px; margin-right: 4px; }
    .opt { margin-left: 14px; margin-top: 3px; font-size: 12px; font-weight: bold; }
    .warn { margin: 4px 0 0 14px; padding: 3px 6px; border: 1px solid #000; font-weight: bold; font-size: 12px; }
    .allergy { margin: 4px 0 0 14px; padding: 4px 6px; border: 2px solid #000; background: #eee; font-weight: bold; font-size: 12px; text-transform: uppercase; }
    .banner { border: 2px solid #000; padding: 6px; margin: 8px 0; font-weight: bold; font-size: 12px; }
    @media print { button.no-print { display: none; } }
  </style>
</head>
<body>
  <h2>KITCHEN PREP TICKET</h2>
  <h3>#${esc(order.order_number || String(order.id).slice(0, 8).toUpperCase())}</h3>
  <div class="meta">
    <div><strong>Restaurant:</strong> ${esc(order.restaurant_name || '')}</div>
    <div><strong>Placed:</strong> ${esc(fmtDateTime(order.placed_at))}</div>
    <div><strong>Customer:</strong> ${esc(order.customer_name || 'Guest')} (${esc(order.customer_phone || 'No phone')})</div>
    <div><strong>Payment:</strong> ${esc(String(order.payment_status || 'pending').toUpperCase())}</div>
    ${order.driver_name ? `<div><strong>Driver:</strong> ${esc(order.driver_name)} ${order.driver_vehicle_plate ? '(' + esc(order.driver_vehicle_plate) + ')' : ''}</div>` : (parseJsonObj(order.rescue_courier)?.name ? `<div><strong>Rescue Courier:</strong> ${esc(parseJsonObj(order.rescue_courier).name)}</div>` : '')}
  </div>
  ${order.special_instructions ? `<div class="banner">ORDER NOTE: ${esc(order.special_instructions)}</div>` : ''}
  ${order.delivery_instructions ? `<div class="banner">DELIVERY NOTE: ${esc(order.delivery_instructions)}</div>` : ''}
  <div class="divider"></div>
  ${itemsBlock || '<div>No items</div>'}
  <div class="divider"></div>
  <div class="meta">
    <div><strong>Address:</strong> ${esc(addr)}</div>
    <div><strong>Total:</strong> R${fmtMoney(order.total_amount)}</div>
  </div>
  <button class="no-print" onclick="window.print()" style="margin-top:14px;width:100%;padding:8px;font-weight:bold;cursor:pointer;">Print Ticket</button>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 180); };</script>
</body>
</html>`;

    const win = window.open('', '_blank', 'width=400,height=640');
    if (!win) {
      alert('Pop-up blocked. Please allow pop-ups for this site to print kitchen tickets.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  async function printKitchenTicketById(orderId, apiBase = '/restaurant/api') {
    const cached = orderCache.get(String(orderId));
    if (cached && cached.order && Array.isArray(cached.items) && cached.items.length > 0) {
      printKitchenTicket(cached.order, cached.items);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/orders/${orderId}`, { credentials: 'same-origin' });
      const data = await res.json();
      if (data && data.order) {
        rememberOrder(data.order, data.items || []);
        printKitchenTicket(data.order, data.items || []);
      }
    } catch (err) {
      console.error('[printKitchenTicketById]', err);
    }
  }

  global.OrderDetails = {
    esc,
    safeId,
    fmtMoney,
    fmtDateTime,
    relativeTime,
    parseAddress,
    parseSelectedOptions,
    formatSelectedOptionsHtml,
    summarizeOptionText,
    rememberOrder,
    rememberOrders,
    renderCompactItemsPreview,
    renderOrderItemsList,
    buildOrderTimelineHtml,
    renderOrderDetailContent,
    printKitchenTicket,
    printKitchenTicketById,
  };
})(window);
