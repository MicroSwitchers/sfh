import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.error('Application error:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif',
                    backgroundColor: '#F5F5F0', color: '#333', padding: '2rem', textAlign: 'center',
                }}>
                    <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Something went wrong</h1>
                    <p style={{ color: '#666', marginBottom: '1.5rem', maxWidth: '400px' }}>
                        The app encountered an unexpected error. Please reload to try again.
                    </p>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            padding: '0.75rem 1.5rem', backgroundColor: '#4488FF', color: '#fff',
                            border: 'none', borderRadius: '0.5rem', fontSize: '1rem', cursor: 'pointer',
                        }}
                    >Reload App</button>
                </div>
            );
        }
        return this.props.children;
    }
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </React.StrictMode>
);
