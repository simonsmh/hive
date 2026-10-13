const endpoints = [
  "GET /api/quote?symbols=NVDA,BTC&source=okx",
  "GET /api/candles?symbol=BTC&source=okx&interval=1m&from=&to=&limit=",
  "GET /api/atr?symbol=XAU&source=okx&period=14",
  "GET /api/health",
];

export default function Home() {
  return (
    <main>
      <h1>Hive 数据服务</h1>
      <p>所有接口需要 HTTP 头 <code>Authorization: Bearer &lt;HIVE_API_TOKEN&gt;</code>。</p>
      <ul>
        {endpoints.map((endpoint) => (
          <li key={endpoint}>
            <code>{endpoint}</code>
          </li>
        ))}
      </ul>
    </main>
  );
}
