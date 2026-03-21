import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Card Front Grader',
  description: 'Front-only trading card centering + flaw grading with visual overlays.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">
          <header style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:16}}>
            <div>
              <h1 style={{margin:'0 0 6px', fontSize:22}}>Card Front Grader</h1>
              <div className="small">Batch process images, compute centering + heuristic flaw metrics, and render overlays.</div>
            </div>
            <div className="badge">
              <span style={{width:8,height:8,borderRadius:999,background:'var(--accent)'}} />
              Next.js + OpenCV.js
            </div>
          </header>
          <main style={{marginTop:18}}>{children}</main>
          <footer style={{marginTop:24}} className="small">
            Built for photo-based grading assistance. Not affiliated with PSA. Use at your own risk.
          </footer>
        </div>
      </body>
    </html>
  );
}
