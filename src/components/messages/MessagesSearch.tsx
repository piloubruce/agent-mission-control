import React, { useState, useMemo } from 'react';
import { Search, Filter, X } from 'lucide-react';

interface MessageFilter {
  agent: string;
  keyword: string;
  dateFrom?: Date;
  dateTo?: Date;
}

interface MessagesSearchProps {
  // Agents de la flotte (objets {agent, name}) — le rendu affiche name + @agent.
  agents: { agent: string; name: string }[];
  onFilter: (filter: MessageFilter) => void;
  onClear: () => void;
}

export const MessagesSearch: React.FC<MessagesSearchProps> = ({ agents, onFilter, onClear }) => {
  const [keyword, setKeyword] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState<Date | null>(null);
  const [dateTo, setDateTo] = useState<Date | null>(null);

  // Debounced search
  React.useEffect(() => {
    const timer = setTimeout(() => {
      onFilter({
        agent: agentFilter,
        keyword,
        dateFrom: dateTo ? new Date(dateTo) : undefined,
        dateTo: dateFrom ? new Date(dateFrom) : undefined,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword, agentFilter, dateFrom, dateTo, onFilter]);

  const hasActiveFilters = keyword || agentFilter || dateFrom || dateTo;

  return (
    <div className="mb-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500" />
          <input
            type="text"
            placeholder="Rechercher dans les messages..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-stone-950 border border-stone-800 rounded-lg text-sm text-stone-200 focus:outline-none focus:border-orange-600"
          />
          {keyword && (
            <button
              onClick={() => setKeyword('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 hover:text-stone-300"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-3 py-2 rounded-lg border ${
            showFilters || hasActiveFilters
              ? 'bg-orange-600/20 border-orange-600 text-orange-400'
              : 'bg-stone-900 border-stone-800 text-stone-400 hover:bg-stone-800'
          } transition-colors`}
        >
          <Filter className="w-4 h-4" />
        </button>
        
        {hasActiveFilters && (
          <button
            onClick={onClear}
            className="px-3 py-2 rounded-lg bg-stone-800 border border-stone-800 text-stone-400 hover:text-stone-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {showFilters && (
        <div className="mt-3 p-4 bg-stone-900/50 border border-stone-800 rounded-xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Agent filter */}
            <div>
              <label className="text-xs text-stone-500 mb-1 block">Agent</label>
              <select
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}
                className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
              >
                <option value="">Tous les agents</option>
                {agents.map(agent => (
                  <option key={agent.agent} value={agent.agent}>
                    {agent.name} (@{agent.agent})
                  </option>
                ))}
              </select>
            </div>

            {/* Date filters */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-stone-500 mb-1 block">Depuis</label>
                <input
                  type="date"
                  value={dateFrom ? formatDate(dateFrom) : ''}
                  onChange={(e) => setDateFrom(e.target.value ? new Date(e.target.value) : null)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
                />
              </div>
              <div>
                <label className="text-xs text-stone-500 mb-1 block">Jusqu'au</label>
                <input
                  type="date"
                  value={dateTo ? formatDate(dateTo) : ''}
                  onChange={(e) => setDateTo(e.target.value ? new Date(e.target.value) : null)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export type { MessageFilter };