// Webview entry point. UI lands in a later phase.
import { createRoot } from 'react-dom/client';

const host = document.getElementById('root');
if (host) {
  createRoot(host).render(<div className="git-control-root" />);
}
