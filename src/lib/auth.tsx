import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase, isOfflineMode } from './supabase';
import type { Profile, Role } from './types';

interface AuthCtx {
  user: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
  isManager: boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

const DEMO_USER: Profile = {
  id: 'demo-admin',
  email: 'admin@electropos.local',
  full_name: 'Shop Administrator',
  role: 'admin',
  active: true,
  created_at: new Date().toISOString(),
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOfflineMode()) {
      // Offline / demo mode — auto login as admin for development
      const saved = localStorage.getItem('electropos_demo_user');
      if (saved) {
        try {
          setUser(JSON.parse(saved));
        } catch {
          setUser(DEMO_USER);
        }
      }
      setLoading(false);
      return;
    }

    // Supabase mode
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        loadProfile(session.user.id);
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        loadProfile(session.user.id);
      } else {
        setUser(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function loadProfile(userId: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !data) {
      setUser(null);
    } else {
      setUser(data as Profile);
    }
    setLoading(false);
  }

  const signIn = async (email: string, password: string) => {
    if (isOfflineMode()) {
      // Simple demo login
      if (email === 'admin@electropos.local' && password === 'admin123') {
        setUser(DEMO_USER);
        localStorage.setItem('electropos_demo_user', JSON.stringify(DEMO_USER));
        return { ok: true };
      }
      if (email === 'cashier@electropos.local' && password === 'cashier123') {
        const cashier: Profile = {
          ...DEMO_USER,
          id: 'demo-cashier',
          email,
          full_name: 'Cashier User',
          role: 'cashier',
        };
        setUser(cashier);
        localStorage.setItem('electropos_demo_user', JSON.stringify(cashier));
        return { ok: true };
      }
      return { ok: false, error: 'Invalid credentials (demo: admin@electropos.local / admin123)' };
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  };

  const signOut = async () => {
    if (isOfflineMode()) {
      setUser(null);
      localStorage.removeItem('electropos_demo_user');
      return;
    }
    await supabase.auth.signOut();
    setUser(null);
  };

  const isAdmin = user?.role === 'admin';
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  return (
    <Ctx.Provider value={{ user, loading, signIn, signOut, isAdmin, isManager }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
