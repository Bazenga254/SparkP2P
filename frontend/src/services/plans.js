/**
 * Single source of truth for subscription plan names + prices in the frontend.
 *
 * Prices live in backend/app/services/plans.py (PLAN_CONFIG) — the same values that set the
 * actual M-Pesa STK amount. NEVER hardcode a plan price or label in a component: copies drifted
 * before and the UI advertised KES 3,000 while the backend charged KES 10,000.
 *
 * Usage:
 *   const { plans, planLabel, planPrice } = usePlans();
 *   planLabel('pro')  -> 'Silver'      planLabel(null) -> 'Free'
 *   planPrice('pro')  -> 7500
 */
import { useEffect, useState } from 'react';
import api from './api';

// Mirrors plans.py. Only used for the first paint, before the fetch lands (and if it fails).
export const PLAN_FALLBACK = [
  { key: 'starter', label: 'Bronze', price: 5000 },
  { key: 'pro',     label: 'Silver', price: 7500 },
  { key: 'pro_max', label: 'Gold',   price: 10000 },
];

// Cache across mounts — the catalogue changes about once a year.
let _cache = null;
let _inflight = null;

export function fetchPlans() {
  if (_cache) return Promise.resolve(_cache);
  if (!_inflight) {
    _inflight = api.get('/subscriptions/plans')
      .then((r) => {
        const list = r.data?.plans;
        if (Array.isArray(list) && list.length) _cache = list;
        return _cache || PLAN_FALLBACK;
      })
      .catch(() => PLAN_FALLBACK)
      .finally(() => { _inflight = null; });
  }
  return _inflight;
}

export function usePlans() {
  const [plans, setPlans] = useState(_cache || PLAN_FALLBACK);
  useEffect(() => {
    let alive = true;
    fetchPlans().then((p) => { if (alive) setPlans(p); });
    return () => { alive = false; };
  }, []);

  const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));
  // 'standard' / 'free' / null / anything unrecognised = no paid plan.
  const planLabel = (key) => byKey[key]?.label || 'Free';
  const planPrice = (key) => byKey[key]?.price ?? 0;

  return { plans, planLabel, planPrice };
}
