import React, { useState } from 'react';
import { 
  Search, RotateCcw, PauseCircle, Lock, Layers, Tag, Award, 
  CalendarCheck, BarChart3, Box, ShoppingBag, Wallet, CreditCard, 
  Smartphone, Building2
} from 'lucide-react';

// Interfaces for TypeScript
interface CartItem {
  id: number;
  name: string;
  code: string;
  price: number;
  qty: number;
  variant: string;
}

interface Product {
  id: number;
  name: string;
  price: string;
  stock: number;
  status: 'normal' | 'low' | 'critical';
  img: string;
}

export default function POS() {
  // Demo State Management
  const [cart, setCart] = useState<CartItem[]>([
    { id: 1, name: 'Samsung Galaxy A15 5G', code: 'NFX-SP-A15', price: 74500, qty: 1, variant: 'Midnight Blue / 128GB' },
    { id: 2, name: 'iPhone 13 128GB', code: 'NFX-SP-IP13', price: 259000, qty: 1, variant: 'Starlight / 128GB' }
  ]);

  const [customer] = useState({ name: 'Nimali Jayasinghe', tier: 'Gold Member', points: 1350 });
  const [paymentMethod, setPaymentMethod] = useState<string>('Cash');
  const [discount] = useState<number>(0);

  const subtotal = cart.reduce((acc, item) => acc + (item.price * item.qty), 0);
  const grandTotal = subtotal - discount;

  const products: Product[] = [
    { id: 1, name: 'Samsung Galaxy A15 5G', price: 'Rs. 74,500', stock: 4, status: 'normal', img: '📱' },
    { id: 2, name: 'Samsung Galaxy S23 FE', price: 'Rs. 178,500', stock: 2, status: 'low', img: '📱' },
    { id: 3, name: 'Apple iPhone 13 128GB', price: 'Rs. 259,000', stock: 6, status: 'normal', img: '📱' },
    { id: 4, name: 'Xiaomi Redmi Note 13', price: 'Rs. 78,900', stock: 12, status: 'normal', img: '📱' },
    { id: 5, name: 'HP Pavilion 15 (i5/16GB)', price: 'Rs. 280,000', stock: 1, status: 'critical', img: '💻' },
    { id: 6, name: 'Lenovo IdeaPad Slim 3', price: 'Rs. 194,500', stock: 3, status: 'low', img: '💻' },
    { id: 7, name: 'JBL Tune 510BT Headset', price: 'Rs. 18,900', stock: 25, status: 'normal', img: '🎧' },
    { id: 8, name: 'Sony WH-CH520 Wireless', price: 'Rs. 22,500', stock: 2, status: 'low', img: '🎧' },
  ];

  const updateQuantity = (id: number, delta: number) => {
    setCart(prev => prev.map(item => {
      if (item.id === id) {
        const newQty = item.qty + delta;
        return newQty > 0 ? { ...item, qty: newQty } : item;
      }
      return item;
    }));
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      
      {/* 1. LEFT SIDEBAR (Navigation & Quick Access) */}
      <aside className="w-16 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-4 space-y-6">
        <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center font-bold text-xl text-white shadow-lg shadow-indigo-500/30">
          N
        </div>
        <nav className="flex-1 space-y-4">
          <button className="p-3 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex justify-center items-center">
            <ShoppingBag className="w-5 h-5" />
          </button>
          <button className="p-3 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition flex justify-center items-center" title="Inventory">
            <Box className="w-5 h-5" />
          </button>
          <button className="p-3 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition flex justify-center items-center" title="Reports">
            <BarChart3 className="w-5 h-5" />
          </button>
          <button className="p-3 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition flex justify-center items-center" title="Attendance">
            <CalendarCheck className="w-5 h-5" />
          </button>
        </nav>
        <div className="flex flex-col items-center space-y-2">
          <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse" title="System Online"></span>
        </div>
      </aside>

      {/* MAIN CONTAINER (40% Cart | 60% Catalog) */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* 2. CART / BILLING PANEL (Left 40%) */}
        <section className="w-[42%] bg-slate-900 border-r border-slate-800 flex flex-col justify-between">
          
          {/* Header & Customer Details */}
          <div className="p-4 border-b border-slate-800 space-y-3">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                  Nexfix POS
                </h1>
                <p className="text-xs text-slate-400">Enterprise Billing Suite</p>
              </div>
              <div className="flex space-x-2">
                <button className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg flex items-center space-x-1 border border-slate-700">
                  <RotateCcw className="w-3.5 h-3.5" /> <span>Return</span>
                </button>
                <button className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg flex items-center space-x-1 border border-slate-700">
                  <PauseCircle className="w-3.5 h-3.5" /> <span>Hold</span>
                </button>
              </div>
            </div>

            {/* Customer Selector Card */}
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <div className="w-8 h-8 rounded-full bg-amber-500/10 text-amber-400 flex items-center justify-center font-bold text-xs border border-amber-500/20">
                    <Award className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-200">{customer.name}</h2>
                    <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full border border-amber-500/30">
                      {customer.tier} • {customer.points} pts
                    </span>
                  </div>
                </div>
                <button className="text-xs bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 px-2.5 py-1 rounded-lg hover:bg-indigo-600/30">
                  Change
                </button>
              </div>
            </div>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {cart.map((item) => (
              <div key={item.id} className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 hover:border-slate-700 transition">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-sm font-medium text-slate-200">{item.name}</h3>
                    <p className="text-xs text-slate-500">{item.code}</p>
                    <span className="inline-block mt-1 text-[11px] bg-slate-800 text-indigo-300 px-2 py-0.5 rounded">
                      Variant: {item.variant}
                    </span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-slate-100">Rs. {(item.price * item.qty).toLocaleString()}</p>
                    <div className="flex items-center space-x-2 mt-2">
                      <button 
                        onClick={() => updateQuantity(item.id, -1)}
                        className="w-6 h-6 bg-slate-800 text-slate-300 rounded flex items-center justify-center hover:bg-slate-700"
                      >-</button>
                      <span className="text-xs font-semibold">{item.qty}</span>
                      <button 
                        onClick={() => updateQuantity(item.id, 1)}
                        className="w-6 h-6 bg-slate-800 text-slate-300 rounded flex items-center justify-center hover:bg-slate-700"
                      >+</button>
                    </div>
                  </div>
                </div>

                {/* Quick Actions per Item */}
                <div className="mt-2 pt-2 border-t border-slate-900 flex justify-between text-[11px] text-slate-400">
                  <button className="flex items-center space-x-1 hover:text-indigo-400">
                    <Lock className="w-3 h-3" /> <span>Price Override</span>
                  </button>
                  <button className="flex items-center space-x-1 hover:text-indigo-400">
                    <Layers className="w-3 h-3" /> <span>Change Variant</span>
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Totals & Payment Section */}
          <div className="p-4 bg-slate-950 border-t border-slate-800 space-y-3">
            <div className="space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between">
                <span>Subtotal ({cart.length} items)</span>
                <span className="text-slate-200 font-medium">Rs. {subtotal.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Discount</span>
                <span className="text-amber-400 font-medium">- Rs. {discount}</span>
              </div>
            </div>

            {/* Grand Total Bar */}
            <div className="bg-indigo-600/20 border border-indigo-500/40 p-3 rounded-xl flex justify-between items-center">
              <div>
                <p className="text-[10px] text-indigo-300 uppercase font-semibold">Grand Total</p>
                <p className="text-xl font-black text-white">Rs. {grandTotal.toLocaleString()}</p>
              </div>
              <Tag className="w-6 h-6 text-indigo-400" />
            </div>

            {/* Payment Method Selector */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Cash', icon: Wallet },
                { label: 'Card', icon: CreditCard },
                { label: 'Mobile', icon: Smartphone },
                { label: 'Bank', icon: Building2 }
              ].map((m) => (
                <button
                  key={m.label}
                  onClick={() => setPaymentMethod(m.label)}
                  className={`p-2 rounded-lg text-xs flex flex-col items-center justify-center space-y-1 border transition ${
                    paymentMethod === m.label 
                      ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/30' 
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
                  }`}
                >
                  <m.icon className="w-4 h-4" />
                  <span>{m.label}</span>
                </button>
              ))}
            </div>

            {/* Complete Sale Button */}
            <button className="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-lg shadow-indigo-600/20 active:scale-[0.99] transition">
              🚀 Complete Sale (F8)
            </button>
          </div>
        </section>

        {/* 3. PRODUCT CATALOG MATRIX (Right 60%) */}
        <section className="flex-1 bg-slate-950 flex flex-col">
          
          {/* Top Search & Filter Bar */}
          <div className="p-4 border-b border-slate-800 flex justify-between items-center space-x-4">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-500" />
              <input 
                type="text" 
                placeholder="Search products by name, SKU or barcode... (F3)"
                className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex space-x-2">
              {['All', 'Smartphones', 'Laptops', 'Audio'].map((cat, idx) => (
                <button key={cat} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${idx === 0 ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-400 hover:bg-slate-800'}`}>
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Catalog Grid */}
          <div className="flex-1 overflow-y-auto p-4 grid grid-cols-4 gap-3 content-start">
            {products.map((p) => (
              <div 
                key={p.id} 
                className="bg-slate-900 p-3 rounded-xl border border-slate-800/80 hover:border-indigo-500/50 hover:shadow-lg transition cursor-pointer flex flex-col justify-between group"
              >
                <div>
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-2xl">{p.img}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                      p.status === 'critical' ? 'bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse' :
                      p.status === 'low' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                      'bg-emerald-500/20 text-emerald-400'
                    }`}>
                      {p.stock} left
                    </span>
                  </div>
                  <h4 className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition line-clamp-2">{p.name}</h4>
                </div>

                <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-100">{p.price}</span>
                  <button className="w-6 h-6 rounded-lg bg-indigo-600/20 text-indigo-400 group-hover:bg-indigo-600 group-hover:text-white flex items-center justify-center text-sm font-bold transition">
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>

        </section>

      </div>
    </div>
  );
}

