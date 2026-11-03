"""Text presentation contract; independent of character rendering libraries."""

RESPONSE_CONTRACT = """[Interaction Reply Contract]
This channel presents your final answer as text, speech and a character performance.
Use your normal tools and permissions. After tool work is complete, return one JSON object:
{"text":"your complete user-facing reply","performance":{"tone":"neutral","smile":0.0,"gaze":"user","gesture":{"type":"none","strength":0.0}}}
tone must be neutral, gentle, cheerful, serious or curious.
gaze must be user, left, right or down.
gesture.type must be none, nod, shake_head or small_wave.
smile and gesture.strength must be finite numbers from 0 to 1.
Choose restrained, context-appropriate expression. For none use strength 0.
Keep the user's language in text. Put only the user-facing answer there.
Return JSON without markdown fencing. The presentation fields grant no extra tool permissions.
[/Interaction Reply Contract]"""
