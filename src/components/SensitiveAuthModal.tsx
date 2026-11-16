import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck, X } from 'lucide-react';
import { apiFetch, ApiError, setCsrfToken, setSessionToken } from '../lib/api';

interface SensitiveAuthModalProps {
  open: boolean;
  actionLabel: string;
  onClose: () => void;
  onVerified: () => void;
}

interface ReauthResponse {
  hasSensitiveAuth: boolean;
  csrfToken: string;
  sessionToken?: string;
}

export function SensitiveAuthModal({
  open,
  actionLabel,
  onClose,
  onVerified,
}: SensitiveAuthModalProps) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setShowPassword(false);
      setError(null);
      return;
    }

    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
    }, 20);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, submitting, onClose]);

  if (!open) return null;

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!password.trim()) {
      setError('Please enter your account password.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<ReauthResponse>('/api/auth/reauth', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (res?.csrfToken) {
        setCsrfToken(res.csrfToken);
      }
      if (res?.sessionToken) {
        setSessionToken(res.sessionToken);
      }
      setPassword('');
      onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F172A]/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white border border-[#E2E8F0] p-6 shadow-lg space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-xl bg-[#EFF6FF] text-[#2563EB] flex items-center justify-center shrink-0">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="reauth-title" className="font-display text-lg font-bold text-[#0F172A]">
                Verify password for sensitive action
              </h2>
              <p className="text-sm text-[#64748B] mt-1">
                Re-enter your account password to {actionLabel}. Unlocks sensitive actions for 15 minutes and rotates your session token.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div role="alert" className="rounded-xl bg-[#DC2626]/10 px-3.5 py-2.5 text-sm text-[#DC2626]">
            {error}
          </div>
        )}

        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div>
            <label htmlFor="reauth-password" className="block text-sm font-medium text-[#0F172A] mb-1">
              Account password
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                id="reauth-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] pl-3.5 pr-10 py-2.5 text-sm focus:border-[#2563EB] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#2563EB]/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-[#64748B] hover:text-[#0F172A]"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-[#E2E8F0] px-4 py-2 text-sm font-medium text-[#0F172A] hover:bg-[#F8FAFC]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-full bg-[#2563EB] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{submitting ? 'Verifying…' : 'Verify & continue'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
