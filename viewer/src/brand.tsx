import lockup from "../../assets/logo/visualice-lockup.svg";
import lockupReversed from "../../assets/logo/visualice-lockup-reversed.svg";
import mark from "../../assets/logo/visualice-mark.svg";
import markReversed from "../../assets/logo/visualice-mark-reversed.svg";
import loaderSvg from "../../assets/loader/visualice-loader-960.svg?raw";

/**
 * The brand artwork from /assets. Each piece renders its light and dark variant
 * and styles.css shows the one matching `data-theme`, so switching theme doesn't
 * re-render anything.
 */

/** Ink of the light-background artwork, and of the reversed (dark-background) set. */
const INK = "#16161a";
const INK_REVERSED = "#f4f2ec";

function Themed({
  light,
  dark,
  className,
  alt,
}: {
  light: string;
  dark: string;
  className: string;
  alt: string;
}) {
  return (
    <>
      <img className={className + " vc-on-light"} src={light} alt={alt} />
      <img className={className + " vc-on-dark"} src={dark} alt={alt} />
    </>
  );
}

/** The full lockup (mark + wordmark), or just the mark where space is tight. */
export function Logo({ markOnly }: { markOnly?: boolean }) {
  return markOnly ? (
    <Themed light={mark} dark={markReversed} className="vc-mark" alt="Visualice" />
  ) : (
    <Themed light={lockup} dark={lockupReversed} className="vc-lockup" alt="Visualice" />
  );
}

// The loader ships only in the light-background ink, so the dark variant is the
// same file recoloured to match the reversed logo. As <img>s its internal
// <style> stays scoped to the SVG instead of leaking into the page.
const svgUrl = (svg: string) => "data:image/svg+xml," + encodeURIComponent(svg);
const LOADER_LIGHT = svgUrl(loaderSvg);
const LOADER_DARK = svgUrl(loaderSvg.replaceAll(INK, INK_REVERSED));

export function Loader() {
  return (
    <div className="vc-loader" role="status" aria-label="Loading">
      <Themed light={LOADER_LIGHT} dark={LOADER_DARK} className="vc-loader-img" alt="" />
    </div>
  );
}
