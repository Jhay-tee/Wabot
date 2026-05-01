import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

function getSecret() {
  if (!env.jwtSecret) {
    throw new Error("JWT_SECRET is not configured. Set it in your environment variables.");
  }
  return env.jwtSecret;
}

export function signAccessToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: "7d", algorithm: "HS256" });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
}
