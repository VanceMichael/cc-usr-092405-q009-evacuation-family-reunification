// 脱敏展示：工作人员列表中只暴露协调所必需的粒度，原值保留在报告中供审计重建。

export function maskName(name) {
  if (!name) return "";
  const trimmed = String(name).trim();
  if (/[a-zA-Z]/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .map((part) => (part.length <= 1 ? part[0] + "*" : part[0] + "*".repeat(Math.min(part.length - 1, 3))))
      .join(" ");
  }
  if ([...trimmed].length <= 1) return trimmed;
  return [...trimmed][0] + "*".repeat(Math.min([...trimmed].length - 1, 2));
}

export function maskPlace(place) {
  if (!place) return "";
  const chars = [...String(place).trim()];
  if (chars.length <= 2) return chars[0] + "**";
  return chars.slice(0, 2).join("") + "**";
}

export function maskChannel() {
  return "***";
}

// 可联系时段：时段本身保留（协调需要），渠道在签发凭据前脱敏
export function maskWindows(windows) {
  return (windows || []).map((w) => ({ from: w.from, to: w.to, channel: maskChannel() }));
}
