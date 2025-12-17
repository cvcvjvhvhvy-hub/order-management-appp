const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 5000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public', {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

let users = [
  { id: '1', name: 'بقالة الأمل', phone: '771234567', role: 'grocery', address: 'صنعاء - شارع الزبيري' },
  { id: '2', name: 'تاجر الجملة', phone: '772345678', role: 'merchant', address: 'صنعاء - شارع المطار' },
  { id: '3', name: 'المسؤول', phone: '773456789', role: 'admin', address: 'صنعاء' }
];

let invoices = [];
let bids = [];

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: 'غير مصرح - يرجى تسجيل الدخول' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ success: false, message: 'غير مصرح' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ success: false, message: 'غير مسموح لهذا الدور' });
    }
    next();
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length < 9) {
    return res.json({ success: false, message: 'رقم هاتف غير صالح' });
  }
  const user = users.find(u => u.phone === phone);
  if (user) {
    req.session.user = { ...user };
    res.json({ success: true, user: { id: user.id, name: user.name, role: user.role } });
  } else {
    res.json({ success: false, message: 'المستخدم غير مسجل' });
  }
});

app.post('/api/register', (req, res) => {
  const { name, phone, role, address } = req.body;
  
  if (!name || name.length < 2) {
    return res.json({ success: false, message: 'الاسم غير صالح' });
  }
  if (!phone || phone.length < 9) {
    return res.json({ success: false, message: 'رقم الهاتف غير صالح' });
  }
  if (!['grocery', 'merchant'].includes(role)) {
    return res.json({ success: false, message: 'نوع الحساب غير صالح' });
  }
  
  const existingUser = users.find(u => u.phone === phone);
  if (existingUser) {
    return res.json({ success: false, message: 'رقم الهاتف مسجل مسبقاً' });
  }
  
  const newUser = {
    id: Date.now().toString(),
    name: name.trim(),
    phone,
    role,
    address: address || ''
  };
  users.push(newUser);
  req.session.user = { ...newUser };
  res.json({ success: true, user: { id: newUser.id, name: newUser.name, role: newUser.role } });
});

app.get('/api/user', (req, res) => {
  if (req.session.user) {
    const user = users.find(u => u.id === req.session.user.id);
    if (user) {
      res.json({ success: true, user: { id: user.id, name: user.name, role: user.role, phone: user.phone, address: user.address } });
    } else {
      req.session.destroy();
      res.json({ success: false });
    }
  } else {
    res.json({ success: false });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/invoices', requireRole('grocery'), (req, res) => {
  const { items, address, phone } = req.body;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'يجب إضافة منتج واحد على الأقل' });
  }
  
  const validItems = items.filter(item => item.name && item.quantity > 0);
  if (validItems.length === 0) {
    return res.status(400).json({ success: false, message: 'المنتجات غير صالحة' });
  }
  
  const user = users.find(u => u.id === req.session.user.id);
  const invoice = {
    id: Date.now().toString(),
    groceryId: req.session.user.id,
    groceryName: user ? user.name : req.session.user.name,
    phone: phone || (user ? user.phone : ''),
    address: address || (user ? user.address : ''),
    items: validItems.map(item => ({ name: item.name.trim(), quantity: parseInt(item.quantity) })),
    status: 'pending',
    lowestPrice: null,
    selectedMerchantId: null,
    createdAt: new Date().toISOString()
  };
  invoices.push(invoice);
  res.json({ success: true, invoice });
});

app.get('/api/invoices', requireAuth, (req, res) => {
  const user = req.session.user;
  let result;
  if (user.role === 'grocery') {
    result = invoices.filter(i => i.groceryId === user.id);
  } else if (user.role === 'merchant') {
    result = invoices.filter(i => i.status === 'pending' || i.status === 'priced');
  } else if (user.role === 'admin') {
    result = invoices;
  } else {
    result = [];
  }
  res.json({ success: true, invoices: result });
});

app.post('/api/bids', requireRole('merchant'), (req, res) => {
  const { invoiceId, totalPrice, itemPrices } = req.body;
  
  if (!invoiceId || totalPrice === undefined) {
    return res.status(400).json({ success: false, message: 'بيانات غير كاملة' });
  }
  
  const invoice = invoices.find(i => i.id === invoiceId);
  if (!invoice) {
    return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });
  }
  
  if (invoice.status === 'approved') {
    return res.status(400).json({ success: false, message: 'تمت الموافقة على هذه الفاتورة مسبقاً' });
  }
  
  const existingBid = bids.find(b => b.invoiceId === invoiceId && b.merchantId === req.session.user.id);
  if (existingBid) {
    return res.status(400).json({ success: false, message: 'لقد قدمت عرضاً مسبقاً على هذه الفاتورة' });
  }
  
  const bid = {
    id: Date.now().toString(),
    invoiceId,
    merchantId: req.session.user.id,
    merchantName: req.session.user.name,
    totalPrice: parseFloat(totalPrice),
    itemPrices: itemPrices || [],
    createdAt: new Date().toISOString()
  };
  bids.push(bid);
  
  invoice.status = 'priced';
  if (!invoice.lowestPrice || bid.totalPrice < invoice.lowestPrice) {
    invoice.lowestPrice = bid.totalPrice;
  }
  
  res.json({ success: true, bid });
});

app.get('/api/bids/:invoiceId', requireAuth, (req, res) => {
  const invoice = invoices.find(i => i.id === req.params.invoiceId);
  if (!invoice) {
    return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });
  }
  
  if (req.session.user.role === 'grocery' && invoice.groceryId !== req.session.user.id) {
    return res.status(403).json({ success: false, message: 'غير مسموح' });
  }
  
  const invoiceBids = bids.filter(b => b.invoiceId === req.params.invoiceId);
  res.json({ success: true, bids: invoiceBids });
});

app.post('/api/invoices/:id/approve', requireAuth, (req, res) => {
  const { merchantId } = req.body;
  const invoice = invoices.find(i => i.id === req.params.id);
  
  if (!invoice) {
    return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });
  }
  
  if (req.session.user.role === 'grocery' && invoice.groceryId !== req.session.user.id) {
    return res.status(403).json({ success: false, message: 'غير مسموح بالموافقة على هذه الفاتورة' });
  }
  
  if (req.session.user.role !== 'grocery' && req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'غير مسموح' });
  }
  
  if (invoice.status === 'approved') {
    return res.status(400).json({ success: false, message: 'تمت الموافقة مسبقاً' });
  }
  
  const bid = bids.find(b => b.invoiceId === req.params.id && b.merchantId === merchantId);
  if (!bid) {
    return res.status(400).json({ success: false, message: 'العرض غير موجود' });
  }
  
  invoice.status = 'approved';
  invoice.selectedMerchantId = merchantId;
  res.json({ success: true, invoice });
});

app.get('/api/users', requireRole('admin'), (req, res) => {
  const safeUsers = users.map(u => ({
    id: u.id,
    name: u.name,
    phone: u.phone,
    role: u.role,
    address: u.address
  }));
  res.json({ success: true, users: safeUsers });
});

app.get('/api/stats', requireRole('admin'), (req, res) => {
  const stats = {
    totalUsers: users.length,
    totalInvoices: invoices.length,
    totalBids: bids.length,
    groceries: users.filter(u => u.role === 'grocery').length,
    merchants: users.filter(u => u.role === 'merchant').length,
    pendingInvoices: invoices.filter(i => i.status === 'pending').length,
    pricedInvoices: invoices.filter(i => i.status === 'priced').length,
    approvedInvoices: invoices.filter(i => i.status === 'approved').length
  };
  res.json({ success: true, stats });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Order Pro Server running on http://0.0.0.0:${PORT}`);
});
