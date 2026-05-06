import { Send, BookOpen } from 'lucide-react';
import { XLogo } from '@/lib/icons';
import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="bg-black border-t border-border py-2 px-2 md:px-6 w-full mt-auto" style={{ height: "40px" }}>
      <div className="mx-auto h-full">
        <div className="flex items-center justify-between h-full gap-2">

          {/* Copyright - shorter on mobile */}
          <p className="text-[10px] font-mono text-gray-500 uppercase tracking-widest whitespace-nowrap">
            <span className="md:hidden">© HYPERSFUN</span>
            <span className="hidden md:inline">© 2026 HYPERSFUN PROTOCOL LABS.</span>
          </p>

          <div className="flex items-center gap-2 md:gap-6">
            {/* Links - shorter on mobile */}
            <div className="flex gap-2 md:gap-6 text-[8px] md:text-[10px] font-mono text-gray-400 uppercase  md:tracking-widest">
              <Link href="/terms-of-service" className="hover:text-primary cursor-pointer transition-colors">Terms of service</Link>
              <Link href="/privacy-policy" className="hover:text-primary cursor-pointer transition-colors">Privacy policy</Link>
            </div>

            {/* Social icons */}
            <div className="flex gap-1 md:gap-2 items-center">
              <a href="https://t.me/hypersfun" target="_blank" rel="noopener noreferrer" className="w-5 h-5 md:w-6 md:h-6 bg-white/5 border border-border flex items-center justify-center hover:border-primary transition-colors cursor-pointer">
                <Send size={10} className="md:w-3 md:h-3" />
              </a>
              <a href="https://x.com/hypersFun" target="_blank" rel="noopener noreferrer" className="w-5 h-5 md:w-6 md:h-6 bg-white/5 border border-border flex items-center justify-center hover:border-primary transition-colors cursor-pointer">
                <XLogo className="w-2.5 h-2.5 md:w-3 md:h-3" />
              </a>
              <a href="https://hyper-fun.gitbook.io/hyper.fun/" target="_blank" rel="noopener noreferrer" className="w-5 h-5 md:w-6 md:h-6 bg-white/5 border border-border flex items-center justify-center hover:border-primary transition-colors cursor-pointer">
                <BookOpen size={10} className="md:w-3 md:h-3" />
              </a>
            </div>
          </div>

        </div>
      </div>
    </footer>
  );
}
