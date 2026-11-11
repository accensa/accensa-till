import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[1320px] flex-col items-start justify-center px-5 py-20 lg:px-8">
      <div className="border border-line bg-panel p-8 sm:p-12">
        <p className="eyebrow flex items-center gap-2 text-acid">
          <span className="h-1.5 w-1.5 bg-acid" />
          404 · Page Not Found
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-bone sm:text-4xl">
          The requested route does not exist.
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
          The page you are looking for has either moved or was not indexed in this build.
        </p>
        <div className="mt-8 flex flex-wrap gap-4">
          <Link className="btn btn-primary" href="/overview">
            Open Console
          </Link>
          <Link className="btn" href="/">
            Return Home
          </Link>
        </div>
      </div>
    </div>
  );
}
