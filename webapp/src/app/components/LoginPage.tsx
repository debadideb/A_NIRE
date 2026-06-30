import { useState, useRef } from 'react';
import { Shield, Eye, EyeOff, AlertCircle } from 'lucide-react';

const VALID_USERS: Record<string, { name: string; role: string }> = {
  '123456': { name: 'A. Diaz',     role: 'AML Analyst' },
  '234567': { name: 'M. Chen',     role: 'Senior Analyst' },
  '345678': { name: 'P. Okonkwo',  role: 'Compliance Officer' },
  '456789': { name: 'S. Kapoor',   role: 'AML Analyst' },
  '567890': { name: 'R. Torres',   role: 'Team Lead' },
};

// Any valid 6-digit ID + "password" (lowercase) is accepted as a demo
const DEMO_PASSWORD = 'password';

interface Props {
  onLogin: (userId: string, name: string, role: string) => void;
}

export function LoginPage({ onLogin }: Props) {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);

  const handleUserIdChange = (val: string) => {
    if (/^\d{0,6}$/.test(val)) {
      setUserId(val);
      setError(null);
      if (val.length === 6) pwRef.current?.focus();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (userId.length !== 6) {
      setError('User ID must be exactly 6 digits.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setLoading(true);

    // Simulate auth delay
    setTimeout(() => {
      const knownUser = VALID_USERS[userId];
      const passwordOk = password === DEMO_PASSWORD;

      if (knownUser && passwordOk) {
        onLogin(userId, knownUser.name, knownUser.role);
      } else if (!knownUser && /^\d{6}$/.test(userId) && passwordOk) {
        // Allow any valid 6-digit ID + correct password
        onLogin(userId, `Analyst ${userId}`, 'AML Analyst');
      } else {
        setError('Invalid user ID or password. (Hint: use "password")');
        setLoading(false);
      }
    }, 600);
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: 'linear-gradient(rgba(99,102,241,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.3) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/30">
            <Shield size={28} className="text-white" />
          </div>
          <h1 className="text-white text-xl tracking-tight">AML Risk Console</h1>
          <p className="text-slate-400 text-xs mt-1">Financial Intelligence Platform</p>
        </div>

        {/* Card */}
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 shadow-2xl">
          <h2 className="text-white mb-1">Sign in</h2>
          <p className="text-slate-400 text-xs mb-6">Enter your analyst credentials to continue</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* User ID */}
            <div>
              <label className="block text-slate-300 text-xs mb-1.5">User ID (6 digits)</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={userId}
                onChange={e => handleUserIdChange(e.target.value)}
                placeholder="000000"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent tracking-widest"
                autoFocus
                autoComplete="username"
              />
              <div className="flex gap-1 mt-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-0.5 rounded-full transition-colors ${
                      i < userId.length ? 'bg-indigo-500' : 'bg-slate-700'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-slate-300 text-xs mb-1.5">Password</label>
              <div className="relative">
                <input
                  ref={pwRef}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(null); }}
                  placeholder="••••••••"
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent pr-10"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 bg-red-900/30 border border-red-800 rounded-lg px-3 py-2">
                <AlertCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-red-300 text-xs">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white py-2.5 rounded-lg text-sm font-semibold transition-colors mt-2"
            >
              {loading ? 'Authenticating…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-slate-500 text-[10px] mt-4">
          Demo: any 6-digit ID · password: <span className="text-slate-400 font-mono">password</span>
        </p>
      </div>
    </div>
  );
}
