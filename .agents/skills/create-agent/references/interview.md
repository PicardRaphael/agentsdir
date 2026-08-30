# Interview bank — sub-agent

Ask only what the code cannot answer. The five discriminating questions:

1. Which single task, and how does the agent know it is finished?
2. Does it modify files or only read? (Feeds the minimal tool set.)
3. Spontaneous delegation or on demand? (Feeds the description and
   whether it says "use proactively".)
4. Which context does it need, knowing it starts fresh and sees nothing
   of the parent conversation?
5. Deep reasoning or bulky mechanical work? (Feeds the model choice.)

Follow up on the output: ask for one example of the exact report the
parent should receive, and write it into the prompt as the required
format.
