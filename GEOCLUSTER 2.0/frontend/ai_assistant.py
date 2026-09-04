from __future__ import annotations

import os
import re

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()


def clean_response(text: str) -> str:
    """Clean reasoning/thinking from AI response."""
    if not text:
        return ""
    
    # Remove <think> tags (common in some models)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    
    # Remove thinking process sections
    text = re.sub(
        r"(?is)^\s*(thinking process|reasoning|analysis|thought process)\s*:.*?(?=\n\s*(final answer|answer|response)\s*:|\Z)",
        "",
        text,
    )
    
    # Remove "final answer:" prefix
    text = re.sub(r"(?im)^\s*(final answer|answer|response)\s*:\s*", "", text)
    
    # Remove numbered steps
    text = re.sub(r"(?im)^\s*(step|stage)\s*\d+.*?(?=\n|$)", "", text)
    
    # Clean up extra whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    
    return text.strip()


class AIAssistant:
    def __init__(self):
        api_key = os.getenv("FIREWORKS_API_KEY")
        if not api_key:
            raise RuntimeError(
                "FIREWORKS_API_KEY not found in .env"
            )
        self.client = OpenAI(
            api_key=api_key,
            base_url="https://api.fireworks.ai/inference/v1",
        )
        # Use Qwen model - better for reasoning control
        self.model = "accounts/fireworks/models/qwen3p7-plus"

    def ask(self, prompt: str) -> str:
        """Send prompt to AI and get cleaned response."""
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": """You are GEOCLUSTER AI, an expert in GIS, Remote Sensing, Photogrammetry, and Earth Observation.

CRITICAL RULES - YOU MUST FOLLOW:
- NEVER include any reasoning, thinking process, or step-by-step analysis in your response
- NEVER show internal thoughts or how you arrived at the answer
- Give ONLY the final, direct answer
- Keep answers concise (1-2 sentences for simple definitions)
- Use bullet points only when listing multiple items
- Provide practical, real-world GIS/Remote Sensing explanations

EXAMPLES:
GOOD: "NDVI measures vegetation health using near-infrared and red light reflectance. Values range from -1 to 1, with healthy vegetation above 0.3."

BAD: "Let me think about this. First, I need to consider what NDVI means. NDVI stands for... The formula is... Here's my answer..."

Remember: Direct answers only. No reasoning. No thinking process."""
                    },
                    {
                        "role": "user",
                        "content": prompt,
                    },
                ],
                temperature=0.3,
                max_tokens=150,
                # Disable reasoning for Qwen
                extra_body={
                    "reasoning_effort": "none"
                }
            )
            answer = response.choices[0].message.content
            return clean_response(answer) if answer else ""
        except Exception as e:
            return f"Error: {str(e)}"