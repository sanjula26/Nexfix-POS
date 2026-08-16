import { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { POSProvider, usePOS } from './lib/store';
import { startSyncManager } from './lib/syncManager';
import AppLayout from './components/AppLayout';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Dashboard from './pages/Dashboard';
import POS from './pages/POS';
import Inventory from './pages/Inventory';
import Customers from './pages/Customers';
import Suppliers from './pages/Suppliers';
import Purchases from './pages/Purchases';
import SalesHistory from './pages/SalesHistory';
import Exchanges from './pages/Exchanges';
import Expenses from './pages/Expenses';
import Reports from './pages/Reports';
import PriceTags from './pages/PriceTags';
import Users from './pages/Users';
import CashierBalances from './pages/CashierBalances';
import Permissions from './pages/Permissions';
import AuditLog from './pages/AuditLog';
import Settings from './pages/Settings';
import Units from './pages/Units';
import Repairs from './pages/Repairs';
import Quotations from './pages/Quotations';
import WarrantyClaims from './pages/WarrantyClaims';
import Kits from './pages/Kits';

function SyncBootstrap() {
  useEffect(() => startSyncManager(), []);
  return null;
}

function Protected() {
  const { user } = usePOS();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <AppLayout />;
}

function Guard({ perm, adminOnly, children }: { perm?: string; adminOnly?: boolean; children: React.ReactNode }) {
  const { user, can } = usePOS();
  if (!user) return null;
  if (adminOnly && user.role !== 'admin') return <Navigate to={can('page:pos') ? '/pos' : '/'} replace />;
  if (perm && !can(perm)) return <Navigate to={can('page:pos') ? '/pos' : '/'} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <POSProvider>
      <SyncBootstrap />
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected />}>
            <Route path="/" element={<Guard perm="page:dashboard"><Dashboard /></Guard>} />
            <Route path="/pos" element={<Guard perm="page:pos"><POS /></Guard>} />
            <Route path="/inventory" element={<Guard perm="page:inventory"><Inventory /></Guard>} />
            <Route path="/units" element={<Guard perm="page:units"><Units /></Guard>} />
            <Route path="/repairs" element={<Guard perm="page:repairs"><Repairs /></Guard>} />
            <Route path="/quotations" element={<Guard perm="page:pos"><Quotations /></Guard>} />
            <Route path="/kits" element={<Guard perm="page:inventory"><Kits /></Guard>} />
            <Route path="/warranty-claims" element={<Guard perm="page:repairs"><WarrantyClaims /></Guard>} />
            <Route path="/customers" element={<Guard perm="page:customers"><Customers /></Guard>} />
            <Route path="/suppliers" element={<Guard perm="page:suppliers"><Suppliers /></Guard>} />
            <Route path="/purchases" element={<Guard perm="page:purchases"><Purchases /></Guard>} />
            <Route path="/sales" element={<Guard perm="page:sales"><SalesHistory /></Guard>} />
            <Route path="/exchanges" element={<Guard perm="page:exchanges"><Exchanges /></Guard>} />
            <Route path="/expenses" element={<Guard perm="page:expenses"><Expenses /></Guard>} />
            <Route path="/reports" element={<Guard perm="page:reports"><Reports /></Guard>} />
            <Route path="/price-tags" element={<Guard perm="page:pricetags"><PriceTags /></Guard>} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/users" element={<Guard adminOnly><Users /></Guard>} />
            <Route path="/cashier-balances" element={<Guard adminOnly><CashierBalances /></Guard>} />
            <Route path="/permissions" element={<Guard adminOnly><Permissions /></Guard>} />
            <Route path="/audit-log" element={<Guard adminOnly><AuditLog /></Guard>} />
            <Route path="/settings" element={<Guard adminOnly><Settings /></Guard>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </POSProvider>
  );
}
