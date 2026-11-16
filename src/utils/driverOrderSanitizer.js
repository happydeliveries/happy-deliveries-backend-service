function computeDriverEarningsFromOrder(order) {
  if (!order) return 0;
  if (
    order.driver_earnings !== undefined &&
    order.driver_earnings !== null &&
    Number.isFinite(Number(order.driver_earnings))
  ) {
    return +Number(order.driver_earnings).toFixed(2);
  }
  const deliveryFee = Number(order.delivery_fee || 0);
  const tipAmount = Number(order.tip_amount || 0);
  const totalAmount = Number(order.total_amount || 0);
  const deliveryShare = deliveryFee > 0 ? deliveryFee * 0.7 : totalAmount * 0.15;
  return +(deliveryShare + tipAmount).toFixed(2);
}

/**
 * Redacts order monetary fields (subtotal, delivery_fee, tax_amount, tip_amount,
 * total_amount, driver_earnings) for drivers until status === 'delivered'.
 */
function sanitizeOrderForDriver(order) {
  if (!order || typeof order !== 'object') return order;
  const copy = { ...order };
  delete copy.verification_code;
  delete copy.code_expires_at;
  delete copy.code_used_at;

  if (copy.status === 'delivered') {
    copy.pricing_hidden = false;
    copy.driver_earnings = computeDriverEarningsFromOrder(copy);
    return copy;
  }

  copy.pricing_hidden = true;
  copy.subtotal = null;
  copy.delivery_fee = null;
  copy.tax_amount = null;
  copy.tip_amount = null;
  copy.total_amount = null;
  copy.driver_earnings = null;
  return copy;
}

function sanitizeOrderItemsForDriver(items, orderStatus) {
  if (!Array.isArray(items)) return [];
  if (orderStatus === 'delivered') return items;

  return items.map((item) => {
    const cleanItem = { ...item };
    cleanItem.unit_price = null;
    cleanItem.total_price = null;

    if (cleanItem.selected_options && typeof cleanItem.selected_options === 'object') {
      const strippedOptions = {};
      for (const [grp, val] of Object.entries(cleanItem.selected_options)) {
        if (Array.isArray(val)) {
          strippedOptions[grp] = val.map((entry) =>
            entry && typeof entry === 'object' ? { name: entry.name || entry.label || '' } : entry
          );
        } else if (val && typeof val === 'object') {
          strippedOptions[grp] = { name: val.name || val.label || '' };
        } else {
          strippedOptions[grp] = val;
        }
      }
      cleanItem.selected_options = strippedOptions;
    }

    return cleanItem;
  });
}

module.exports = {
  computeDriverEarningsFromOrder,
  sanitizeOrderForDriver,
  sanitizeOrderItemsForDriver,
};
