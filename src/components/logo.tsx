export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="logo-wrap">
      <div className="logo-mark"><span>5</span></div>
      {!compact && (
        <div>
          <strong>Casa Cinco</strong>
          <small>shared living OS</small>
        </div>
      )}
    </div>
  );
}
