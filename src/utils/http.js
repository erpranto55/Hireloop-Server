export function notFound(res, message = "Resource not found") {
  return res.status(404).json({ message });
}

export function badRequest(res, message = "Invalid request") {
  return res.status(400).json({ message });
}

export function created(res, data) {
  return res.status(201).json(data);
}