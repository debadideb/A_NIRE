import { Search, Bell, Settings, LogOut, Info } from 'lucide-react';
import { AMLCase } from '../data/cases';
import { CaseSelector } from './CaseSelector';

interface Props {
  userId: string;
  userName: string;
  userRole: string;
  selectedCaseId: string | null;
  onCaseSelect: (c: AMLCase) => void;
  onLogout: () => void;
}

export function Header({ userId, userName, userRole, selectedCaseId, onCaseSelect, onLogout }: Props) {
  const initials = userName.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="bg-white border-b border-gray-200 flex-shrink-0">
      {/* Main bar */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-3">
          {/* Brand */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-6 h-6 bg-slate-900 rounded flex items-center justify-center">
              <div className="w-2.5 h-2.5 border-2 border-orange-400 rounded-sm" />
            </div>
            <span className="text-sm font-semibold text-slate-800 tracking-tight">AML Console</span>
          </div>

          <div className="h-4 w-px bg-gray-200" />

          {/* Case selector dropdown */}
          <CaseSelector selectedCaseId={selectedCaseId} onSelect={onCaseSelect} />
        </div>

        <div className="flex items-center gap-1.5">
          <button className="p-1.5 rounded-md hover:bg-gray-100 transition-colors">
            <Search size={14} className="text-gray-500" />
          </button>
          <button className="p-1.5 rounded-md hover:bg-gray-100 transition-colors relative">
            <Bell size={14} className="text-gray-500" />
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-red-500" />
          </button>
          <button className="p-1.5 rounded-md hover:bg-gray-100 transition-colors">
            <Settings size={14} className="text-gray-500" />
          </button>

          <div className="h-4 w-px bg-gray-200 mx-1" />

          <div className="flex items-center gap-2">
            <div>
              <div className="text-xs font-medium text-slate-700 leading-none">{userName}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{userRole} · {userId}</div>
            </div>
            <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center cursor-pointer">
              <span className="text-[10px] text-white font-semibold">{initials}</span>
            </div>
          </div>

          <button
            onClick={onLogout}
            title="Sign out"
            className="p-1.5 rounded-md hover:bg-red-50 hover:text-red-600 text-gray-400 transition-colors ml-1"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      {/* Sub-bar: entity context + hint */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-slate-50 border-t border-gray-100">
        {selectedCaseId ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-gray-400 uppercase tracking-widest">Active case</span>
            <span className="text-[10px] font-mono text-slate-500">{selectedCaseId}</span>
          </div>
        ) : (
          <div className="text-[10px] text-gray-400">Select a case from the dropdown to begin analysis</div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
          <Info size={11} />
          <span>Hover a node · drag to reposition · click to isolate · use slider to filter by flow size</span>
        </div>
      </div>
    </div>
  );
}
