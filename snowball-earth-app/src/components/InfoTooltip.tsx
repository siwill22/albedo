import { useState } from 'react';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
    text: string;
}

export function InfoTooltip({ text }: InfoTooltipProps) {
    const [isVisible, setIsVisible] = useState(false);

    return (
        <div
            style={{ position: 'absolute', top: '15px', right: '15px', zIndex: 10 }}
            onMouseEnter={() => setIsVisible(true)}
            onMouseLeave={() => setIsVisible(false)}
            onClick={() => setIsVisible(!isVisible)}
        >
            <div style={{ cursor: 'pointer', opacity: 0.7, padding: '5px' }}>
                <Info size={18} color="#94a3b8" />
            </div>

            {isVisible && (
                <div style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    width: '250px',
                    background: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    padding: '10px',
                    fontSize: '0.85em',
                    color: '#f1f5f9',
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5)',
                    zIndex: 20
                }}>
                    {text}
                </div>
            )}
        </div>
    );
}
