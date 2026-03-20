const servers = [
  { name: "EU 1", url: "https://eu-1.sprawl.nl" },
];

export default function Home() {
  return (
    <div class="lobby">
      <h1>Sprawl</h1>
      <p>City builder & traffic sim</p>
      <div class="servers">
        {servers.map((s) => (
          <a href={s.url}>{s.name}</a>
        ))}
      </div>
    </div>
  );
}
