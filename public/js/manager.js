// Manager Dashboard JavaScript

class ManagerDashboard {
    constructor() {
        this.socket = null;
        this.liveOrderCount = 0;
        this.initialize();
    }

    initialize() {
        this.setupEventListeners();
        this.setupWebSocket();
        // REMOVE: this.updateLiveStats();
        this.startAutoRefresh();
    }

    setupEventListeners() {
        // Period selector
        const periodSelect = document.getElementById('periodSelect');
        if (periodSelect) {
            periodSelect.addEventListener('change', (e) => {
                this.updateDashboardData(e.target.value);
            });
        }

        // Search functionality
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce(this.handleSearch.bind(this), 300));
        }

        // Filter buttons
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filter = e.target.dataset.filter;
                this.applyFilter(filter);
            });
        });
    }

    setupWebSocket() {
        if (typeof io === 'undefined') {
            console.warn('Socket.IO client is not loaded. Real-time updates are disabled.');
            return;
        }

        this.socket = io();

        this.socket.on('connect', () => {
            console.log('Socket.IO connected');
            this.socket.emit('join_manager_room');
            const managerId = window.managerId || null;
            if (managerId) {
                this.socket.emit('join_manager', managerId);
            }
        });

        this.socket.on('new_order', (payload) => {
            const order = payload?.order || payload || {};
            this.liveOrderCount++;
            this.updateOrderCounter();
            this.showNotification(`New order #${order.order_number || order.orderId || order.id || ''} received! Awaiting your approval.`, 'success');

            if (typeof loadPendingOrders === 'function') loadPendingOrders();
            if (typeof loadRecentOrders === 'function') loadRecentOrders();
            if (typeof loadOrdersTab === 'function') loadOrdersTab();
            if (typeof loadOrders === 'function') loadOrders(window.currentPage || 1, true);
            if (typeof loadStats === 'function') loadStats();
            if (typeof loadDashboardData === 'function') loadDashboardData();
        });

        this.socket.on('order_updated', (payload) => {
            const order = payload?.order || payload || {};
            const statusLabel = payload?.payment_status === 'completed'
                ? 'paid (finding driver)'
                : (order.status || payload?.status || 'updated');
            this.showNotification(`Order #${order.order_number || order.orderId || order.id || ''} is now ${statusLabel}`, 'info');

            if (typeof loadPendingOrders === 'function') loadPendingOrders();
            if (typeof loadRecentOrders === 'function') loadRecentOrders();
            if (typeof loadOrdersTab === 'function') loadOrdersTab();
            if (typeof loadOrders === 'function') loadOrders(window.currentPage || 1, true);
            if (typeof loadStats === 'function') loadStats();
            if (typeof loadDashboardData === 'function') loadDashboardData();
        });

        this.socket.on('live_stats', (payload) => {
            const { stats } = payload;
            this.updateStatsCards(stats);
            this.updateLiveStatsDisplay(stats);
        });

        this.socket.on('disconnect', () => {
            console.log('Socket.IO disconnected. Reconnecting...');
        });

        this.socket.on('connect_error', (error) => {
            console.error('Socket.IO connect error:', error);
        });
    }

    handleWebSocketMessage(data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'new_order':
                this.handleNewOrder(data.order);
                break;
            case 'order_updated':
                this.handleOrderUpdate(data.order);
                break;
            case 'live_stats':
                this.updateLiveStatsDisplay(data.stats);
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    }

    handleNewOrder(order) {
        this.liveOrderCount++;
        this.updateOrderCounter();
        this.showNotification(`New order #${order.order_number || order.id} received!`, 'success');

        if (typeof loadPendingOrders === 'function') loadPendingOrders();
        if (typeof loadRecentOrders === 'function') loadRecentOrders();
        if (typeof loadOrdersTab === 'function') loadOrdersTab();
        if (typeof loadDashboardData === 'function') loadDashboardData();
    }

    handleOrderUpdate(order) {
        if (typeof loadPendingOrders === 'function') loadPendingOrders();
        if (typeof loadRecentOrders === 'function') loadRecentOrders();
        if (typeof loadOrdersTab === 'function') loadOrdersTab();
        if (typeof loadDashboardData === 'function') loadDashboardData();
    }

    updateDashboardData(period = 'today') {
        fetch(`/manager/api/dashboard/stats?period=${period}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    this.updateStatsCards(data.stats);
                    this.updateCharts(data.charts);
                }
            })
            .catch(error => console.error('Error updating dashboard:', error));
    }

    updateStatsCards(stats) {
        const elements = {
            totalRevenue: document.getElementById('totalRevenue'),
            totalOrders: document.getElementById('totalOrders'),
            avgRating: document.getElementById('avgRating'),
            activeOrders: document.getElementById('activeOrders'),
            revenueChange: document.getElementById('revenueChange'),
            ordersChange: document.getElementById('ordersChange')
        };

        if (elements.totalRevenue) elements.totalRevenue.textContent = `₹${stats.total_revenue || '0'}`;
        if (elements.totalOrders) elements.totalOrders.textContent = stats.total_orders || '0';
        if (elements.avgRating) elements.avgRating.textContent = `${stats.avg_rating || '0'} ⭐`;
        if (elements.activeOrders) elements.activeOrders.textContent = stats.active_orders || '0';
        
        if (elements.revenueChange) {
            elements.revenueChange.textContent = `${stats.revenue_change || '0'}%`;
            elements.revenueChange.className = stats.revenue_change > 0 ? 'text-success' : 'text-danger';
        }
        
        if (elements.ordersChange) {
            elements.ordersChange.textContent = `${stats.orders_change || '0'}%`;
            elements.ordersChange.className = stats.orders_change > 0 ? 'text-success' : 'text-danger';
        }
    }

    updateLiveStatsDisplay(stats) {
        const liveElements = {
            todayOrders: document.getElementById('todayOrders'),
            todayRevenue: document.getElementById('todayRevenue'),
            activeDrivers: document.getElementById('activeDrivers')
        };

        Object.keys(liveElements).forEach(key => {
            if (liveElements[key] && stats[key] !== undefined) {
                liveElements[key].textContent = stats[key];
            }
        });
    }

    updateOrderCounter() {
        const counter = document.getElementById('liveOrderCount');
        const urgentCounter = document.getElementById('urgentOrders');
        
        if (counter) {
            counter.textContent = this.liveOrderCount;
            
            if (this.liveOrderCount > 0) {
                counter.classList.add('live-badge');
            }
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `alert alert-${type} alert-dismissible fade show position-fixed`;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 9999;
            min-width: 300px;
        `;
        notification.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    startAutoRefresh() {
        // Safety net only: refresh every 5 minutes in case a socket event was missed
        setInterval(() => {
            if (window.location.pathname.includes('dashboard')) {
                this.updateDashboardData();
            }
            if (window.location.pathname.includes('orders')) {
                this.refreshOrders();
            }
        }, 300000); // 5 minutes
    }

    refreshOrders() {
        const currentPage = window.currentPage || 1;
        if (typeof loadOrders === 'function') {
            loadOrders(currentPage);
        }
    }
}

// Utility Functions
function getManagerApiBase() {
    if (typeof API !== 'undefined') return API;
    if (typeof API_BASE !== 'undefined') return API_BASE;
    if (typeof window !== 'undefined' && window.location.pathname.startsWith('/manager')) {
        return '/manager/api';
    }
    return '/api/manager';
}

function formatCurrency(amount) {
    return `R ${parseFloat(amount || 0).toFixed(2)}`;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

function formatTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Menu Management Functions
function toggleMenuItemAvailability(itemId, currentStatus) {
    const newStatus = !currentStatus;
    
    fetch(`/api/manager/menu/items/${itemId}/availability`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ is_available: newStatus })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            const statusBadge = document.querySelector(`#item-${itemId} .status-badge`);
            if (statusBadge) {
                statusBadge.textContent = newStatus ? 'Available' : 'Unavailable';
                statusBadge.className = newStatus ? 'badge bg-success' : 'badge bg-danger';
            }
            
            showNotification(`Item ${newStatus ? 'enabled' : 'disabled'} successfully!`, 'success');
        }
    });
}

function editMenuItem(itemId) {
    fetch(`/api/manager/menu/items/${itemId}`)
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                const item = data.item;
                document.getElementById('editItemName').value = item.name;
                document.getElementById('editItemPrice').value = item.price;
                document.getElementById('editItemDescription').value = item.description || '';
                document.getElementById('editItemAvailability').checked = item.is_available;
                
                const modal = new bootstrap.Modal(document.getElementById('editItemModal'));
                modal.show();
                
                document.getElementById('editItemForm').onsubmit = (e) => {
                    e.preventDefault();
                    updateMenuItem(itemId);
                };
            }
        });
}

function updateMenuItem(itemId) {
    const formData = new FormData(document.getElementById('editItemForm'));
    
    fetch(`/api/manager/menu/items/${itemId}`, {
        method: 'PUT',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            bootstrap.Modal.getInstance(document.getElementById('editItemModal')).hide();
            showNotification('Item updated successfully!', 'success');
            if (typeof loadMenuItems === 'function') {
                loadMenuItems();
            }
        }
    });
}

// Pending orders: load, accept, and reject helpers
async function loadPendingOrders() {
    try {
        const res = await fetch(`${getManagerApiBase()}/orders/pending`, { credentials: 'same-origin' });
        const data = await res.json();
        const tbody = document.getElementById('pendingOrdersTableBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!data.success || !Array.isArray(data.orders) || data.orders.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding:2rem;">No pending orders awaiting approval</td></tr>`;
            return;
        }
        for (const o of data.orders) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>#${o.order_number || o.id.slice(0, 8)}</strong></td>
                <td class="truncate">${o.customer_name || '—'}</td>
                <td><strong>${formatCurrency(o.total_amount || 0)}</strong></td>
                <td>${formatDate(o.placed_at || o.created_at)} ${formatTime(o.placed_at || o.created_at)}</td>
                <td>
                  <div style="display:flex; gap:0.5rem; align-items:center;">
                    <button class="btn btn-success btn-sm publish-btn" data-order-id="${o.id}">Accept</button>
                    <button class="btn btn-danger btn-sm reject-btn" data-order-id="${o.id}">Reject</button>
                  </div>
                </td>
            `;
            tbody.appendChild(tr);
        }

        document.querySelectorAll('.publish-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.orderId;
                await acceptOrder(id, btn);
            });
        });
        document.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.orderId;
                await rejectOrder(id, btn);
            });
        });
    } catch (err) {
        console.error('Error loading pending orders', err);
    }
}

async function acceptOrder(orderId, btnEl = null) {
    try {
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.textContent = 'Accepting...';
        }
        const res = await fetch(`${getManagerApiBase()}/orders/${orderId}/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin'
        });
        const data = await res.json();
        if (data.success) {
            if (typeof showToast === 'function') {
                showToast('Order Accepted', 'Customer can now complete payment.', 'success');
            } else {
                window.showNotification('Order accepted! Customer can now complete payment.', 'success');
            }
            if (typeof closeModal === 'function' && document.getElementById('orderModal')?.classList.contains('active')) {
                closeModal('orderModal');
            }
            if (typeof loadPendingOrders === 'function') loadPendingOrders();
            if (typeof loadOrders === 'function') loadOrders(window.currentPage || 1, true);
            if (typeof loadStats === 'function') loadStats();
            if (typeof loadRecentOrders === 'function') loadRecentOrders();
            if (typeof loadOrdersTab === 'function') loadOrdersTab();
            if (window.managerDashboard) window.managerDashboard.updateDashboardData();
        } else {
            if (typeof showToast === 'function') {
                showToast('Error', data.error || 'Failed to accept order', 'danger');
            } else {
                window.showNotification(data.error || 'Failed to accept order', 'danger');
            }
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Accept'; }
        }
    } catch (err) {
        console.error('Accept order error', err);
        window.showNotification('Error accepting order', 'danger');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Accept'; }
    }
}

// Keep publishOrder as alias for backward compatibility
const publishOrder = acceptOrder;
window.acceptOrder = acceptOrder;
window.publishOrder = acceptOrder;

async function rejectOrder(orderId, btnEl = null) {
    try {
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.textContent = 'Rejecting...';
        }

        const res = await fetch(`${getManagerApiBase()}/orders/${orderId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin'
        });
        const data = await res.json();
        if (data.success) {
            if (typeof showToast === 'function') {
                showToast('Order Rejected', 'Order has been cancelled and is no longer available.', 'info');
            } else {
                window.showNotification('Order rejected and cancelled.', 'success');
            }
            if (typeof closeModal === 'function' && document.getElementById('orderModal')?.classList.contains('active')) {
                closeModal('orderModal');
            }
            if (typeof loadPendingOrders === 'function') loadPendingOrders();
            if (typeof loadOrders === 'function') loadOrders(window.currentPage || 1, true);
            if (typeof loadStats === 'function') loadStats();
            if (typeof loadOrdersTab === 'function') loadOrdersTab();
            if (typeof loadRecentOrders === 'function') loadRecentOrders();
            if (window.managerDashboard) window.managerDashboard.updateDashboardData();
        } else {
            if (typeof showToast === 'function') {
                showToast('Error', data.error || 'Failed to reject order', 'danger');
            } else {
                window.showNotification(data.error || 'Failed to reject order', 'danger');
            }
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Reject'; }
        }
    } catch (err) {
        console.error('Reject order error', err);
        window.showNotification('Error rejecting order', 'danger');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Reject'; }
    }
}
window.rejectOrder = rejectOrder;

// Initialize dashboard when page loads  
document.addEventListener('DOMContentLoaded', function() {
    if (window.location.pathname.includes('/manager/')) {
        window.managerDashboard = new ManagerDashboard();
    }
    
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });
    
    if (window.location.pathname.includes('dashboard')) {
        loadPendingOrders();
    }
});

// Global showNotification function
window.showNotification = function(message, type = 'info') {
    if (window.managerDashboard) {
        window.managerDashboard.showNotification(message, type);
    }
};