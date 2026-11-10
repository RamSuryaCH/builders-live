import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function Qr({ text, alt }: { text: string; alt: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: 480, color: { dark: "#132337", light: "#ffffff" } }).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [text]);
  if (!src) return <div className="qr-box" aria-hidden="true" />;
  return <img src={src} alt={alt} />;
}
