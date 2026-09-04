from frontend.ai_assistant import AIAssistant

def test_ai():
    """Test AI Assistant with various queries."""
    print("Testing AI Assistant...")
    print("=" * 50)
    
    ai = AIAssistant()
    
    test_queries = [
        "What is NDVI in one sentence?",
        "Explain K-Means clustering for satellite images",
        "How does Sentinel-2 work?",
    ]
    
    for query in test_queries:
        print(f"\nUser: {query}")
        print("-" * 30)
        response = ai.ask(query)
        print(f"AI: {response}")
        print("=" * 50)

if __name__ == "__main__":
    test_ai()