// 两粒度的拉普拉斯机制与预算账本。
//
// 敏感度：每个人员经规则收敛后恰好贡献 0 或 1 条保留记录，因此
// “某地区计数”在相邻数据集（最多一人不同）之间的 L1 敏感度为 1。
// 单次提交若选择多个地区，每个地区的计数是彼此独立的一次查询，
// 额度按地区分别扣减（复用一个额度集合时按集合总消耗记账），不做均摊。
// 页面按每个地区一份额度展示，因此本原型中的“一次提交”费用 = 地区数 × 额度。
//
// 非负处理：把 raw_noisy 截断为 max(0, x) 会改变分布——负值质量折叠到 0，
// 期望抬高约 scale/2，且这种偏差在 ns 很大时可见。raw 与显示值分别保存。

import { randomInt } from 'node:crypto';

export function sensitivityForSingleRegionCount() {
  return 1;
}

export class SecureRng {
  // crypto.randomInt(max) 在 [0, max) 上取值且拒绝偏置采样结果；
  // 两次采样拼出 60 位精度，再加半格使结果严格位于 (0,1)。
  next() {
    const denom = 2 ** 30;
    const hi = randomInt(0, denom);
    const lo = randomInt(0, denom);
    return ((hi * denom + lo) + 0.5) / denom / denom;
  }
}

export function laplaceSample(scale, rng = new SecureRng()) {
  const u = rng.next();
  if (!(u > 0 && u < 1)) throw new Error('随机数必须严格位于 (0,1)');
  const magnitude = -scale * Math.log(1 - 2 * Math.abs(u - 0.5));
  return u < 0.5 ? magnitude : -magnitude;
}

export function runLaplaceForRegions({ regions, trueCounts, epsilon }, rng = new SecureRng()) {
  const sensitivity = sensitivityForSingleRegionCount();
  const scale = sensitivity / epsilon;
  return regions.map((code) => {
    const trueValue = trueCounts.get(code);
    if (trueValue === undefined) throw new Error('未知地区代码: ' + code);
    const rawNoisy = trueValue + laplaceSample(scale, rng);
    return {
      region_code: code,
      true_value: trueValue,
      raw_noisy: rawNoisy,
      display_value: Math.max(0, rawNoisy),
      noise_scale: scale,
      sensitivity
    };
  });
}

// 展示非负处理带来的期望偏移（对纯噪声 X ~ Lap(scale)）：
// E[max(0, X)] = scale/2，因此 display 的净偏差 = display 期望 - 真值。
export function clampBias(scale) {
  return scale / 2;
}

export function roundForStorage(value) {
  // 保存 6 位小数即可忠实区分噪声，避免浮点尾巴污染输出。
  return Number(value.toFixed(6));
}
