import Footer from '@/components/Footer';
import Logo from '@/components/Logo';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-dark flex flex-col text-white selection:bg-primary/30">
      <nav className="bg-black h-16 border-b border-border">
        <div className="w-full h-full px-4 flex items-center">
          <a href="/" className="flex items-center gap-3 group">
            <Logo size={58} />
            <div className="flex flex-col">
              <span className="text-xl font-black tracking-tighter uppercase italic leading-none text-white">
                HYPERS<span className="text-primary">FUN</span>
              </span>
              <span className="text-[8px] font-bold text-gray-500 uppercase tracking-[0.4em]">Exchange Liquidity Layer</span>
            </div>
          </a>
        </div>
      </nav>
      <main className="flex-1 w-full max-w-[1800px] mx-auto flex items-center justify-center">
        <div className="text-center px-4">
          <div className="mb-8 flex justify-center">
            <video
              autoPlay
              loop
              muted
              playsInline
              className="w-full max-w-md border border-border overflow-hidden rounded-lg"
            >
              <source src="/images/404.webm" type="video/webm" />
            </video>
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            Page Not Found
          </h2>
          <p className="text-gray-400 text-lg mb-8 mx-auto">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center h-10 px-8 bg-primary text-black font-black text-[10px] uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all rounded-sm"
          >
            Go Back Home
          </a>
        </div>
      </main>
      <Footer />
    </div>
  );
}
