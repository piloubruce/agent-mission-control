import React from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  agent?: string;
  timestamp: number;
  read: boolean;
}

interface NotificationToastProps {
  notification: Notification;
  onClose: () => void;
}

export const NotificationToast: React.FC<NotificationToastProps> = ({ notification, onClose }) => {
  const getTypeIcon = () => {
    switch (notification.type) {
      case 'success': return <CheckCircle className="w-4 h-4" />;
      case 'error': return <XCircle className="w-4 h-4" />;
      case 'warning': return <AlertTriangle className="w-4 h-4" />;
      default: return <Info className="w-4 h-4" />;
    }
  };

  const getTypeColor = () => {
    switch (notification.type) {
      case 'success': return 'bg-emerald-900/20 border-emerald-800';
      case 'error': return 'bg-red-900/20 border-red-800';
      case 'warning': return 'bg-amber-900/20 border-amber-800';
      default: return 'bg-blue-900/20 border-blue-800';
    }
  };

  const getTextColor = () => {
    switch (notification.type) {
      case 'success': return 'text-emerald-300';
      case 'error': return 'text-red-300';
      case 'warning': return 'text-amber-300';
      default: return 'text-blue-300';
    }
  };

  return (
    <div className={`border-l-4 p-3 mb-2 rounded-lg shadow-lg animate-slide-in ${getTypeColor()}`}>
      <div className="flex items-start gap-2">
        <div className={`p-1.5 rounded-full ${getTextColor()}`}>
          {getTypeIcon()}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-stone-200">{notification.title}</span>
            {notification.agent && (
              <span className="text-xs text-stone-500">[{notification.agent}]</span>
            )}
            <button
              onClick={onClose}
              className="text-stone-500 hover:text-stone-300 ml-auto"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <p className="text-xs text-stone-400 mt-0.5">{notification.message}</p>
          <div className="text-xs text-stone-600 mt-1">
            {new Date(notification.timestamp).toLocaleTimeString('fr-FR')}
          </div>
        </div>
      </div>
    </div>
  );
};