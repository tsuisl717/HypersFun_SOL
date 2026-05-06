
import React from 'react';
import Image from 'next/image';

interface LogoProps {
  size?: number;
  className?: string;
}

const Logo: React.FC<LogoProps> = ({ size = 48, className = "" }) => {
  return (
    <div className={`relative flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      <Image
        src="/images/logo.png"
        alt="HypersFun Logo"
        width={size}
        height={size}
        className="w-full h-full"
      />
    </div>
  );
};

export default Logo;
